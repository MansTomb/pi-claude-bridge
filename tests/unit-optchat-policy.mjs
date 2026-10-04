import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSession, getProjectDir, openSession, repairToolPairing } from "cc-session-io";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { QueryContext } from "../src/query-state.js";
import { makePromptStream } from "../src/prompt-stream.js";
import { readPersistedSession } from "../src/transcript-checkpoints.js";
import { convertPiMessages } from "../src/convert.js";
import { createTurnSessionPolicy, turnStreamOptions } from "../src/session-policy.js";
import { __test, createOptChatTurn, registerForkParent, releaseSession } from "../src/index.js";

const view = [
	{ type: "text", text: "view 50k\n", cache_control: { type: "ephemeral", ttl: "5m" } },
	{ type: "text", text: "view 80k\n", cache_control: { type: "ephemeral", ttl: "5m" } },
	{ type: "text", text: "view 100k\n", cache_control: { type: "ephemeral", ttl: "5m" } },
	{ type: "text", text: "remaining view\n\nnew input" },
];

describe("OptChat structured user input", () => {
	it("extracts text-only cache blocks with exact bytes and boundaries", () => {
		const messages = [{ role: "user", content: view }, { role: "user", content: "steer" }];
		const before = structuredClone(messages);
		assert.deepEqual(__test.extractUserPromptBlocks(messages), [...view, { type: "text", text: "steer" }]);
		assert.deepEqual(messages, before);
	});

	it("keeps marks when importing fixed history into in-memory CC records", () => {
		const messages = [{ role: "user", content: view }];
		const before = structuredClone(messages);
		const converted = convertPiMessages(messages).anthropicMessages;
		assert.deepEqual(converted, [{ role: "user", content: view }]);
		const session = createSession({ projectPath: process.cwd(), sessionId: "11111111-1111-4111-8111-111111111111" });
		session.importMessages(repairToolPairing(converted));
		assert.deepEqual(session.records.map((record) => record.message.content), [view]);
		assert.deepEqual(messages, before);
	});

	it("preserves image ordering beside supplied cache blocks", () => {
		const messages = [{ role: "user", content: [view[0], { type: "image", data: "aW1hZ2U=", mimeType: "image/png" }, view[3]] }];
		const expected = [view[0], { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } }, view[3]];
		assert.deepEqual(__test.extractUserPromptBlocks(messages), expected);
		assert.deepEqual(convertPiMessages(messages).anthropicMessages, [{ role: "user", content: expected }]);
	});

	it("keeps the default plain-text fallback and excludes earlier turns", () => {
		const messages = [
			{ role: "user", content: view },
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
			{ role: "user", content: [{ type: "text", text: "next" }] },
		];
		assert.equal(__test.extractUserPromptBlocks(messages), null);
		assert.deepEqual(convertPiMessages([messages[2]]).anthropicMessages, [{ role: "user", content: [{ type: "text", text: "next" }] }]);
		assert.deepEqual(__test.extractUserPromptBlocks([{ role: "user", content: view }]), view);
	});

	it("preserves unmarked structured text boundaries when the turn policy opts in", () => {
		const content = [{ type: "text", text: "short view\n" }, { type: "text", text: "new message" }];
		assert.deepEqual(__test.extractUserPromptBlocks([{ role: "user", content }], true), content);
		assert.equal(__test.extractUserPromptBlocks([{ role: "user", content }]), null);
		assert.equal(__test.extractUserPromptBlocks([{ role: "user", content: [{ type: "text", text: "" }] }], true), null);
	});

	it("keeps an explicit cache TTL without changing legacy empty filtering", () => {
		const content = [
			{ type: "text", text: "" },
			{ type: "text", text: "verbatim\n\n", cache_control: { type: "ephemeral", ttl: "1h" } },
		];
		const messages = [{ role: "user", content }];
		assert.deepEqual(__test.extractUserPromptBlocks(messages), [content[1]]);
		assert.deepEqual(convertPiMessages(messages).anthropicMessages, [{ role: "user", content: [content[1]] }]);
	});

	it("retains signed reasoning and parallel tool results around marked steering", () => {
		const messages = [
			{ role: "assistant", provider: "claude-bridge", content: [
				{ type: "thinking", thinking: "plan", thinkingSignature: "signature" },
				{ type: "toolCall", id: "one", name: "read", arguments: { path: "a" } },
				{ type: "toolCall", id: "two", name: "read", arguments: { path: "b" } },
			] },
			{ role: "toolResult", toolCallId: "one", content: "A" },
			{ role: "user", content: [view[0]] },
			{ role: "toolResult", toolCallId: "two", content: "B" },
		];
		assert.deepEqual(repairToolPairing(convertPiMessages(messages).anthropicMessages), [
			{ role: "assistant", content: [
				{ type: "thinking", thinking: "plan", signature: "signature" },
				{ type: "tool_use", id: "one", name: "Read", input: { path: "a" } },
				{ type: "tool_use", id: "two", name: "Read", input: { path: "b" } },
			] },
			{ role: "user", content: [
				{ type: "tool_result", tool_use_id: "one", content: "A", is_error: undefined },
				{ type: "tool_result", tool_use_id: "two", content: "B", is_error: undefined },
			] },
			{ role: "user", content: [view[0]] },
		]);
	});

	it("keeps cache blocks through Pi's finalized transcript replay", () => {
		const messages = [
			{ role: "system", content: "stable instructions", timestamp: 0 },
			{ role: "user", content: view, timestamp: 1 },
		];
		const context = __test.toBridgeContext({ messages });
		assert.equal(context.systemPrompt, "stable instructions");
		assert.deepEqual(__test.extractUserPromptBlocks(context.messages, true), view);
		assert.deepEqual(convertPiMessages(context.messages).anthropicMessages, [{ role: "user", content: view }]);
	});

	it("preserves supported text citations alongside the cache mark", () => {
		const block = { type: "text", text: "quoted text", cache_control: { type: "ephemeral", ttl: "5m" }, citations: [] };
		assert.deepEqual(__test.extractUserPromptBlocks([{ role: "user", content: [block] }]), [block]);
		assert.deepEqual(convertPiMessages([{ role: "user", content: [block] }]).anthropicMessages, [{ role: "user", content: [block] }]);
	});

	it("preserves nullable SDK metadata without inventing an empty cache mark", () => {
		const block = { type: "text", text: "uncached text", cache_control: null, citations: null };
		assert.deepEqual(__test.extractUserPromptBlocks([{ role: "user", content: [block] }]), [block]);
		assert.deepEqual(convertPiMessages([{ role: "user", content: [block] }]).anthropicMessages, [{ role: "user", content: [block] }]);
	});
});

describe("OptChat transport policy", () => {
	const first = { kind: "fresh-turn", turnId: "delivery-one", sessionKey: "turn-one" };
	const second = { kind: "fresh-turn", turnId: "delivery-two", sessionKey: "turn-two" };

	it("binds tool and steering requests to explicit turn identity instead of Pi history identity", () => {
		assert.deepEqual(turnStreamOptions({ sessionId: "visible-pi", reasoning: "high" }, first), { sessionId: "turn-one", reasoning: "high" });
		assert.deepEqual(turnStreamOptions({ sessionId: "visible-pi", maxTokens: 100 }, first), { sessionId: "turn-one", maxTokens: 100 });
		assert.deepEqual(turnStreamOptions({ sessionId: "visible-pi" }, second), { sessionId: "turn-two" });
		assert.deepEqual(turnStreamOptions(undefined, second), { sessionId: "turn-two" });
	});

	it("retains the explicitly allocated key and validates the transport identity", () => {
		assert.deepEqual(createTurnSessionPolicy({ turnId: "delivery-one", sessionKey: "turn-one" }), first);
		assert.deepEqual(createTurnSessionPolicy({ turnId: "delivery-two", sessionKey: "turn-two" }), second);
		assert.throws(() => createTurnSessionPolicy({ turnId: " ", sessionKey: "turn-one" }), /nonempty transport turnId/);
	});
});

const history = [
	{ role: "user", content: [view[0]] },
	{ role: "assistant", content: [{ type: "text", text: "recorded answer" }] },
];
const tail = [
	{ role: "user", content: [{ type: "text", text: "missed input" }] },
	{ role: "assistant", content: [{ type: "text", text: "missed answer" }] },
];
const current = { role: "user", content: [{ type: "text", text: "current input" }] };

function fixedSession(name, persist) {
	const key = `optchat-${name}-${persist}`;
	const cwd = join(process.env.CLAUDE_CONFIG_DIR, "fixtures", key);
	const sync = __test.syncSharedSession(key, [...history, current], cwd, undefined, undefined, persist);
	assert.equal(sync.path, "rebuild");
	assert.deepEqual(openSession({ projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR, sessionId: sync.sessionId }).records.map((record) => record.message.content), [
		[view[0]], [{ type: "text", text: "recorded answer" }],
	]);
	return { key, cwd, sync };
}

function assertPersistence(key, cwd, sessionId, length, persist) {
	const saved = readPersistedSession(key, cwd, process.env.CLAUDE_CONFIG_DIR);
	if (persist) {
		assert.equal(saved.sessionId, sessionId);
		assert.equal(saved.checkpoints.at(-1).length, length);
	} else {
		assert.equal(saved, undefined);
		assert.equal(existsSync(join(getProjectDir(cwd, process.env.CLAUDE_CONFIG_DIR), "pi-claude-bridge")), false);
	}
	assert.equal(__test.getSharedSession(key).sessionId, sessionId);
	assert.equal(__test.getSharedSession(key).checkpoints.at(-1).length, length);
}

describe("OptChat checkpoint persistence", () => {
	for (const persist of [false, undefined]) {
		const writes = persist !== false;
		it(`initial rebuild ${writes ? "keeps default sidecars" : "skips OptChat sidecars"}`, () => {
			const { key, cwd, sync } = fixedSession("initial", persist);
			assertPersistence(key, cwd, sync.sessionId, 2, writes);
		});

		it(`checkpoint recovery ${writes ? "keeps default sidecars" : "skips OptChat sidecars"}`, () => {
			const { key, cwd } = fixedSession("recovery", persist);
			__test.markRebuildForSession(key);
			const rebuilt = __test.syncSharedSession(key, [...history, ...tail, current], cwd, undefined, undefined, persist);
			assert.equal(rebuilt.path, "rebuild");
			assert.equal(rebuilt.preservedRecords, 2);
			assert.deepEqual(openSession({ projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR, sessionId: rebuilt.sessionId }).records.map((record) => record.message.content), [
				[view[0]], [{ type: "text", text: "recorded answer" }],
				[{ type: "text", text: "missed input" }], [{ type: "text", text: "missed answer" }],
			]);
			assertPersistence(key, cwd, rebuilt.sessionId, 4, writes);
		});

		it(`fork with a tail ${writes ? "keeps default sidecars" : "skips OptChat sidecars"}`, () => {
			const { key, cwd, sync } = fixedSession("fork", persist);
			const child = `${key}-child`;
			registerForkParent(child, key);
			const forked = __test.syncSharedSession(child, [...history, ...tail, current], cwd, undefined, undefined, persist);
			assert.equal(forked.path, "fork");
			assert.equal(forked.preservedRecords, 2);
			assert.notEqual(forked.sessionId, sync.sessionId);
			assertPersistence(child, cwd, forked.sessionId, 4, writes);
		});

		it(`completed checkpoints ${writes ? "keep default sidecars" : "skip OptChat sidecars"}`, () => {
			const { key, cwd, sync } = fixedSession("completed", persist);
			const leaf = __test.getSharedSession(key).checkpoints[0].leaf;
			__test.recordCompletedQuery(key, sync.sessionId, cwd, [...history, current], leaf, persist);
			assertPersistence(key, cwd, sync.sessionId, 3, writes);
			assert.equal(__test.getSharedSession(key).checkpoints.at(-1).trailingAssistant, true);
		});
	}

	it("does not restore its own sidecar when persistence is disabled", () => {
		const { key, cwd, sync } = fixedSession("restore", undefined);
		const persisted = readPersistedSession(key, cwd, process.env.CLAUDE_CONFIG_DIR);
		__test.resetSharedSession(key);
		const rebuilt = __test.syncSharedSession(key, [...history, current], cwd, undefined, undefined, false);
		assert.equal(rebuilt.path, "rebuild");
		assert.notEqual(rebuilt.sessionId, sync.sessionId);
		assert.deepEqual(readPersistedSession(key, cwd, process.env.CLAUDE_CONFIG_DIR), persisted);
	});

	it("does not restore a fork parent's sidecar when persistence is disabled", () => {
		const { key, cwd } = fixedSession("restore-parent", undefined);
		const child = `${key}-child`;
		registerForkParent(child, key);
		__test.resetSharedSession(key);
		const rebuilt = __test.syncSharedSession(child, [...history, current], cwd, undefined, undefined, false);
		assert.equal(rebuilt.path, "rebuild");
		assert.equal(readPersistedSession(child, cwd, process.env.CLAUDE_CONFIG_DIR), undefined);
		assert.equal(__test.getSharedSession(key), null);
		assert.equal(__test.getSharedSession(child).cursor, 2);
	});
});

describe("OptChat settlement after query teardown", () => {
	for (const stopReason of ["stop", "length", "error", "aborted"]) {
		it(`allows release immediately after ${stopReason} settlement and rejects live release`, async () => {
			const key = `optchat-settle-${stopReason}`;
			const c = new QueryContext();
			c.piSessionId = key;
			c.resetTurnState({ api: "anthropic-messages", provider: "claude-bridge", id: "fixed-data" });
			c.turnOutput.content = [{ type: "text", text: "fixed result" }];
			c.turnOutput.stopReason = stopReason;
			const stream = createAssistantMessageEventStream();
			c.currentPiStream = stream;
			const promptStream = makePromptStream();
			c.promptStream = promptStream;
			const waitingInput = assert.rejects(promptStream.stream.next(), /query ended/);
			let closed = false;
			let terminalState;
			const push = stream.push.bind(stream);
			stream.push = (event) => {
				if (event.type === "done" || event.type === "error") {
					terminalState = { closed, active: __test.activeQueryContexts.has(c), promptStream: c.promptStream };
				}
				push(event);
			};
			const resource = { close() { closed = true; } };
			c.activeQuery = resource;
			__test.activeQueryContexts.add(c);
			__test.setSharedSession(key, { sessionId: "fixed-session", cursor: 1, cwd: "/fixed-data" });
			let toolReply;
			c.pendingToolCalls.set("pending-tool", { toolName: "read", resolve(result) { toolReply = result; } });
			assert.throws(() => releaseSession(key), /still active/);
			assert.equal(__test.getSharedSession(key).sessionId, "fixed-session");
			__test.finishQuery(c, resource, promptStream, true);
			const result = await stream.result();
			releaseSession(key);
			assert.deepEqual(result.content, [{ type: "text", text: "fixed result" }]);
			assert.equal(result.stopReason, stopReason);
			assert.deepEqual(terminalState, { closed: true, active: false, promptStream: null });
			assert.equal(c.activeQuery, null);
			assert.equal(c.promptStream, null);
			assert.equal(__test.activeQueryContexts.has(c), false);
			assert.equal(__test.getSharedSession(key), null);
			assert.deepEqual(toolReply, { content: [{ type: "text", text: "Query ended" }] });
			const events = [];
			for await (const event of stream) events.push({ type: event.type, reason: event.reason });
			assert.deepEqual(events, [
				{ type: "start", reason: undefined },
				{ type: stopReason === "stop" || stopReason === "length" ? "done" : "error", reason: stopReason },
			]);
			await waitingInput;
		});
	}

	it("keeps a replacement query active when the old query cleans up", () => {
		const c = new QueryContext();
		c.piSessionId = "optchat-replacement";
		const previousInput = makePromptStream();
		const nextInput = makePromptStream();
		let closed = false;
		const previous = { close() { closed = true; } };
		const next = { close() {} };
		c.activeQuery = next;
		c.promptStream = nextInput;
		__test.activeQueryContexts.add(c);
		try {
			__test.finishQuery(c, previous, previousInput);
			assert.equal(closed, true);
			assert.equal(c.activeQuery, next);
			assert.equal(c.promptStream, nextInput);
			assert.throws(() => releaseSession(c.piSessionId), /still active/);
		} finally {
			__test.finishQuery(c, next, nextInput);
		}
	});


	it("does not settle the replacement stream when a discarded query cleans up", () => {
		const c = new QueryContext();
		c.piSessionId = "optchat-discarded";
		c.resetTurnState({ api: "anthropic-messages", provider: "claude-bridge", id: "fixed-data" });
		const previousInput = makePromptStream();
		const previous = { close() {} };
		c.activeQuery = previous;
		c.promptStream = previousInput;
		__test.activeQueryContexts.add(c);
		__test.discardRewrittenQuery(c);
		const nextInput = makePromptStream();
		const next = { close() {} };
		const stream = createAssistantMessageEventStream();
		c.activeQuery = next;
		c.promptStream = nextInput;
		c.currentPiStream = stream;
		__test.activeQueryContexts.add(c);
		try {
			__test.finishQuery(c, previous, previousInput, true);
			assert.equal(c.currentPiStream, stream);
			assert.equal(c.activeQuery, next);
			assert.throws(() => releaseSession(c.piSessionId), /still active/);
		} finally {
			__test.finishQuery(c, next, nextInput, true);
		}
	});

	it("makes an idle turn release idempotent and rejects reuse", () => {
		const turn = createOptChatTurn({ turnId: "fixed-delivery" });
		assert.equal(turn.turnId, "fixed-delivery");
		turn.release();
		turn.release();
		assert.throws(() => turn.streamSimple(undefined, undefined), /has been released/);
	});
});
