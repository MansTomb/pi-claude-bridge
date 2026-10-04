import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSession, repairToolPairing } from "cc-session-io";
import { convertPiMessages } from "../src/convert.js";
import { createTurnSessionPolicy, optChatQueryOptions, turnStreamOptions } from "../src/session-policy.js";
import { __test } from "../src/index.js";

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

	it("constructs the request-end policy while preserving gateway wiring and unrelated body fields", () => {
		const options = {
			resume: "same-turn-cc",
			tools: [],
			env: {
				ANTHROPIC_BASE_URL: "http://gateway.example.invalid",
				ANTHROPIC_AUTH_TOKEN: "synthetic-token",
				DISABLE_PROMPT_CACHING: "0",
				CLAUDE_CODE_EXTRA_BODY: '{"metadata":{"user_id":"synthetic"},"cache_control":{"type":"ephemeral","ttl":"1h"}}',
			},
		};
		const before = structuredClone(options);
		assert.deepEqual(optChatQueryOptions(options), {
			resume: "same-turn-cc",
			tools: [],
			env: {
				ANTHROPIC_BASE_URL: "http://gateway.example.invalid",
				ANTHROPIC_AUTH_TOKEN: "synthetic-token",
				DISABLE_PROMPT_CACHING: "1",
				CLAUDE_CODE_EXTRA_BODY: '{"metadata":{"user_id":"synthetic"},"cache_control":{"type":"ephemeral","ttl":"5m"}}',
			},
		});
		assert.deepEqual(options, before);
	});

	it("constructs the end mark without reading or changing the process environment", () => {
		assert.deepEqual(optChatQueryOptions({ tools: [] }), {
			tools: [],
			env: { DISABLE_PROMPT_CACHING: "1", CLAUDE_CODE_EXTRA_BODY: '{"cache_control":{"type":"ephemeral","ttl":"5m"}}' },
		});
	});

	it("rejects malformed extra-body input before request construction", () => {
		for (const raw of ["null", "[]", "42", '"text"']) {
			assert.throws(() => optChatQueryOptions({ env: { CLAUDE_CODE_EXTRA_BODY: raw } }), /JSON object/);
		}
		assert.throws(() => optChatQueryOptions({ env: { CLAUDE_CODE_EXTRA_BODY: "{" } }), SyntaxError);
		assert.deepEqual(optChatQueryOptions({ env: { CLAUDE_CODE_EXTRA_BODY: "{}" } }).env, {
			DISABLE_PROMPT_CACHING: "1", CLAUDE_CODE_EXTRA_BODY: '{"cache_control":{"type":"ephemeral","ttl":"5m"}}',
		});
	});
});
