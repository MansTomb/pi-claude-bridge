import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
const canonicalMessages = messages => withoutCacheMarkers(messages).map(message => ({ ...message, content: typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content }));
const withoutCacheMarkers = value => JSON.parse(JSON.stringify(value, (key, entry) => key === "cache_control" ? undefined : entry));

test("a real SDK refresh makes one capped request on an isolated fork and leaves the next turn clean", { timeout: 90_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-cache-refresh-"));
  const config = join(root, "config");
  const cwd = join(root, "workspace");
  mkdirSync(config);
  mkdirSync(cwd);
  const originalCwd = process.cwd();
  const saved = { ...process.env };
  const requests = [];
  let held;
  let received;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url.startsWith("/v1/messages")) { response.writeHead(404).end(); return; }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    if (held) { received(); return; }
    const warm = body.max_tokens === 1;
    const event = (name, payload) => `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      event("message_start", { type: "message_start", message: { id: `msg_refresh_${requests.length}`, type: "message", role: "assistant", content: [], model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 20, cache_read_input_tokens: 4000 } } }),
      event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "X" } }),
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
      event("message_delta", { type: "message_delta", delta: { stop_reason: warm ? "max_tokens" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }),
      event("message_stop", { type: "message_stop" }),
    ].join(""));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  Object.assign(process.env, { CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: "synthetic-only", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "", ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_MAX_RETRIES: "0" });
  process.chdir(cwd);
  try {
    const { default: activate, refreshSessionCache, releaseSession, __test } = await import("../src/index.js");
    let provider;
    delete globalThis[Symbol.for("claude-bridge:activeStreamSimple")];
    activate({ on() {}, registerTool() {}, registerProvider(_id, value) { provider = value; } });
    const configured = provider.models.find(model => model.id.includes("sonnet"));
    assert.ok(configured);
    const model = { ...configured, provider: "claude-bridge", api: "claude-bridge", baseUrl: "claude-bridge" };
    const context = { systemPrompt: "Synthetic cache fixture. ".repeat(500), tools: [{ name: "read", description: "Read a fixture", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }], messages: [{ role: "user", content: "Remember copper-owl", timestamp: 1 }] };
    const options = { sessionId: "fixture-room", reasoning: "medium" };
    const first = await provider.streamSimple(model, context, options).result();
    assert.equal(first.stopReason, "stop");
    const state = __test.getSharedSession(options.sessionId);
    assert.ok(state.checkpoints.length);
    const parentFile = files(config).find(path => path.endsWith(`${state.sessionId}.jsonl`));
    assert.ok(parentFile);
    const before = readFileSync(parentFile, "utf8");
    const controller = new AbortController();
    const requestStarted = new Promise(resolve => { received = resolve; });
    held = true;
    const interrupted = refreshSessionCache({ sessionId: options.sessionId, signal: controller.signal });
    const stopped = assert.rejects(interrupted);
    await requestStarted;
    assert.deepEqual(await refreshSessionCache({ sessionId: options.sessionId }), { kind: "unsupported", reason: "refresh-active" });
    assert.throws(() => releaseSession(options.sessionId), /refreshing/);
    controller.abort();
    await stopped;
    assert.equal(readFileSync(parentFile, "utf8"), before, "aborting a refresh changed the parent");
    held = false;
    assert.deepEqual(await refreshSessionCache({ sessionId: options.sessionId }), { kind: "refreshed", input: 12, cacheRead: 4000, cacheWrite: 20 });
    assert.equal(requests.length, 3, "the warm subprocess automatically continued after max_tokens");
    assert.equal(requests[2].max_tokens, 1);
    assert.equal(readFileSync(parentFile, "utf8"), before);
    assert.deepEqual(withoutCacheMarkers(requests[2].system), withoutCacheMarkers(requests[0].system));
    assert.deepEqual(withoutCacheMarkers(requests[2].tools), withoutCacheMarkers(requests[0].tools));
    assert.deepEqual(requests[2].thinking, requests[0].thinking);
    assert.deepEqual(requests[2].output_config, requests[0].output_config);
    assert.deepEqual(canonicalMessages(requests[2].messages.slice(0, requests[0].messages.length)), canonicalMessages(requests[0].messages));
    const next = await provider.streamSimple(model, { ...context, messages: [...context.messages, first, { role: "user", content: "Ordinary next Player line", timestamp: 2 }] }, options).result();
    assert.equal(next.stopReason, "stop");
    assert.equal(requests.length, 4);
    assert.ok(!JSON.stringify(requests[3].messages).includes("Refresh the prompt cache"));
    await new Promise(resolve => setImmediate(resolve));
    releaseSession(options.sessionId);
    assert.deepEqual(await refreshSessionCache({ sessionId: options.sessionId }), { kind: "unsupported", reason: "no-completed-query" });
  } finally {
    process.chdir(originalCwd);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
