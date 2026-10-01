# Bridge under pi-durable

Integration tests that run the bridge as the model provider of a [pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable) harness, the way ludocosm will. They call the real Claude Code through the Agent SDK and spend subscription quota, a few short Sonnet requests per test.

```bash
cd tests/durable
npm install
npm test                 # every test
npm test -- restart      # files whose name contains "restart"
```

`BRIDGE_TEST_MODEL` picks the model (default `claude-sonnet-5-5`). Claude Code must be logged in, and a proxy set in `ANTHROPIC_BASE_URL` must know that model.

The package has its own Pi 1.0 dependencies because the bridge root still builds against Pi 0.87. `run.mjs` copies `../../src` into `.bridge/src` so the bridge resolves this package's modules.

`patches/@earendil-works+pi-durable+1.0.0.patch` makes pi-durable send the conversation id as the provider `sessionId`. pi-durable 1.0.0 sends none, and without it every conversation shares one Claude Code session.

The bridge is loaded with a stand-in for pi's extension API that only captures the provider registration. No agent session events fire under pi-durable.

| File | Covers |
|---|---|
| `restart.test.ts` | The host is killed while a replay-safe tool runs, and while an answer streams; the reopened harness finishes the turn and the tool's effect applies once |
| `conversations.test.ts` | A fork and its parent in parallel, a manual compaction summarized by the bridge, an abort mid-answer |
| `handoff.test.ts` | A `beforeCompact` hook writes its own summary for 25 s while three turns are played; they stay verbatim after it |
