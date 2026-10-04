# OptChat transport policy

OptChat is opt-in. The default extension keeps ludocosm's session behavior. The bridge continues to route calls through the Claude Agent SDK and Claude Code. Its subprocess inherits the existing CLIProxy endpoint and authentication environment. This change adds no HTTP client or proxy.

## Provider registration

Import `createOptChatExtension`, `createOptChatTurn`, and the `OptChatTurn` type from `src/index.ts`. Load the returned extension instead of the default bridge extension. It registers the same `claude-bridge` provider and models through Pi's existing `registerProvider` API.

`createOptChatTurn({ turnId })` creates a transport handle with these members:

- `turnId` is the caller's nonempty top-level delivery identity.
- `streamSimple(model, context, options)` is a Pi provider callback bound to that handle's private session key and query context.
- `release()` forgets the handle's in-memory session mirror and prevents later calls. It is idempotent after settlement and throws while its SDK query remains active. Final success, error, and abort results settle after provider teardown, so release is safe immediately after `await stream.result()`. A tool-use result only parks the query for tool delivery and does not allow release. Abort through Pi's signal before releasing an interrupted turn.

`createOptChatExtension({ turnForRequest })` returns a Pi extension factory. The synchronous resolver receives the provider's `SimpleStreamOptions` and returns the handle that owns the request. Missing ownership must throw before transport. The harness owns that association, including its lifetime. The bridge adds no process-global turn registry.

For a harness with one active turn per visible Pi session, the registration looks like this:

```ts
import type { OptChatTurn } from "pi-claude-bridge/src/index.ts";
import { createOptChatExtension, createOptChatTurn } from "pi-claude-bridge/src/index.ts";

const turns = new Map<string, OptChatTurn>();
const extension = createOptChatExtension({
	turnForRequest(options) {
		const turn = options?.sessionId ? turns.get(options.sessionId) : undefined;
		if (!turn) throw new Error("No accepted OptChat turn owns this provider request");
		return turn;
	},
});

function acceptTurn(piSessionId: string, transportTurnId: string) {
	if (turns.has(piSessionId)) throw new Error("The previous OptChat turn is still active");
	turns.set(piSessionId, createOptChatTurn({ turnId: transportTurnId }));
}

function settleTurn(piSessionId: string) {
	const turn = turns.get(piSessionId);
	if (!turn) throw new Error("No OptChat turn to settle");
	turn.release();
	turns.delete(piSessionId);
}
```

Supply `extension` through Pi's inline extension registration. Call `acceptTurn` once after durable top-level input preparation and before the provider starts. Call `settleTurn` after provider teardown. Do not create a handle on Pi's `turn_start`, per tool step, per provider request, or for input that steers an active turn. Every tool step and steer retains the same handle. A later top-level turn gets a new handle, even if its visible Pi session ID stays the same.

The private key replaces `options.sessionId` only inside the bridge. It never enters user text, system text, or tool schemas. Each handle has a separate `QueryContext`. The bridge keeps the existing MCP delivery, SDK query, streaming input, and reasoning loop. A user-only provider call while that query is active is rejected; steering follows Pi's existing delivery at the tool boundary.

The opt-in path skips persisted bridge-session restoration and checkpoint sidecar writes. History conversion imports only the context the harness supplied. It does not read Pi's full session file. The harness must provide the frozen view, new input, and current-turn entries, enforce its finalized-context guard, and disable automatic Pi compaction and cache warming. The bridge cannot identify prior-turn text that the harness wrongly supplies as current input.

Pi's existing `cacheRetention: "none"` one-off summarization path remains isolated and does not join a turn handle's session. It is not the OptChat memory-view transport. AskClaude also retains its existing separate SDK path. Keep AskClaude disabled in the managed harness if its native Claude Code tools are outside the approved tool set.

## Cache construction and its evidence

The harness supplies structured Pi text blocks with Anthropic `cache_control` metadata. `BridgeTextContent` in `src/user-content.ts` extends Pi's text type with the SDK's cache and citation fields. The bridge preserves those fields, text bytes, and block order in prompt extraction, steering, conversion, and in-memory `cc-session-io` imports. OptChat also preserves unmarked text-array boundaries. Ordinary unmarked default-provider text retains its previous string fallback and empty-block filtering.

The harness owns view splitting. For a sufficiently long view, it places three `{ type: "ephemeral", ttl: "5m" }` marks at the last newlines before characters 50,000, 80,000, and 100,000. It skips positions beyond the view's end. This bridge neither splits the view nor adds marks to its blocks.

`optChatQueryOptions` constructs the Claude subprocess environment with `DISABLE_PROMPT_CACHING=1` and `CLAUDE_CODE_EXTRA_BODY` containing top-level `cache_control: { type: "ephemeral", ttl: "5m" }`. It preserves other inherited environment variables and unrelated extra-body keys, replaces a conflicting top-level cache mark, and rejects non-object extra-body JSON before session setup.

The initial source inspection used SDK 0.3.280 with Claude Code 2.1.280. Its `Options.env` documents subprocess environment replacement. Its `Settings.maxEffortLevel` documentation mentions `CLAUDE_CODE_EXTRA_BODY`; the bundled CLI contains the variable and diagnostics requiring a JSON object. `Options` has no typed `extraBody` or top-level `cache_control` setting. `promptCacheTtl` controls mark lifetime and does not express a request-end mark. The environment mechanism is the existing request construction route used here.

The branch now builds on ludocosm `5dbaa66` and pins SDK 0.3.283. Type checking and all 85 fixed-data OptChat tests pass after that rebase. No SDK prompt or wire capture has been run on the updated version.

Fixed-input tests prove that the bridge constructs this environment and retains the three supplied marks. They do not prove that Claude Code forwards the fourth mark, suppresses every automatic mark, or that CLIProxy accepts the resulting cache layout. The bundled CLI also contains a diagnostic that organization policy can disable `CLAUDE_CODE_EXTRA_BODY`. Those behaviors need an approved request capture through the existing gateway. No end-to-end cache claim follows from these unit tests.

## Verification commands

These commands send no agent prompts:

```sh
npm ci --ignore-scripts
npm run typecheck
npm run test:optchat-unit
git diff --check
```

`test:optchat-unit` explicitly selects fixed-input conversion, in-memory import, transcript replay, option construction, query teardown, and checkpoint persistence tests. It does not call an SDK query, Pi prompt, fake endpoint, or live provider. The in-memory import fixture never saves its session records. Checkpoint tests write fixed transcripts and sidecars only under the preload's temporary Claude directory, which it removes on exit. Teardown tests use fixed lifecycle resources without invoking an SDK query.

The following existing regression commands send agent prompts and require approval of each concrete run. They test default ludocosm behavior, not the OptChat handle API:

```sh
tests/int-smoke.sh
tests/int-multi-turn.sh
tests/int-cache.sh
```

They source `.env.test`; inspect that route privately before approving them and require its Claude endpoint to remain CLIProxy. Do not execute `npm test`, `npm run test:unit`, or all `tests/int-*.mjs` as the safe gate. Some unit suites invoke the provider with fake queries, and integration suites invoke Pi or the SDK. `diag/capture-proxy.mjs` forwards to `api.anthropic.com` and buffers responses, so it is unsuitable for this task's gateway and streaming contract.

An OptChat pilot still needs its own inspected harness command before approval. Its concrete run must name the model, endpoint, prompt count, synthetic view and tool fixtures, steering timing, token budget, timeout, and capture retention. It must exercise at least two top-level handles, one tool continuation, and steering in the first handle. Inspect the actual gateway-bound request bodies for exactly the supplied view marks plus the top-level five-minute mark, and verify distinct Claude session IDs across handles. No such pilot command has run or been approved here.
