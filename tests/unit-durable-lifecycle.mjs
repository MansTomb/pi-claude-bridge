import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { registerForkParent, releaseSession, __test } from "../src/index.js";

afterEach(() => __test.resetSharedSession());

describe("durable host lifecycle", () => {
  it("registers a stable parent without an extension session event", () => {
    registerForkParent("child", "parent");
    registerForkParent("child", "parent");
    assert.equal(__test.forkParents.get("child"), "parent");
    assert.throws(() => registerForkParent("child", "other"), /different fork parent/);
    assert.throws(() => registerForkParent("same", "same"), /distinct/);
  });
  it("starts a host-registered fork at the parent's verified checkpoint without a session header", () => {
    const messages = [
      { role: "user", content: "Remember copper-owl", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "Remembered" }], timestamp: 2 },
    ];
    __test.setSharedSession("checkpoint-parent", { sessionId: "claude-parent", cursor: 2, cwd: process.cwd() });
    __test.recordCompletedQuery("checkpoint-parent", "claude-parent", process.cwd(), messages.slice(0, -1), "checkpoint-leaf");
    registerForkParent("checkpoint-child", "checkpoint-parent");
    const synced = __test.syncSharedSession("checkpoint-child", [...messages, { role: "user", content: "Write the handoff", timestamp: 3 }], process.cwd());
    assert.deepEqual(synced, { sessionId: "claude-parent", path: "fork", resumeAt: "checkpoint-leaf", fork: true, forkBase: "claude-parent:checkpoint-leaf" });
    assert.equal(__test.getSharedSession("checkpoint-child").forkPending, true);
    assert.equal(__test.getSharedSession("checkpoint-parent").sessionId, "claude-parent");
  });
  it("releases only the closed session without resetting the provider registration", () => {
    const symbol = Symbol.for("claude-bridge:activeStreamSimple");
    const provider = () => {};
    globalThis[symbol] = provider;
    __test.setSharedSession("parent", { sessionId: "parent-cc", cursor: 0, cwd: "/tmp" });
    __test.setSharedSession("child", { sessionId: "child-cc", cursor: 0, cwd: "/tmp" });
    registerForkParent("child", "parent");
    __test.historyRewrittenBySession.add("child");
    releaseSession("child");
    releaseSession("child");
    assert.equal(__test.getSharedSession("child"), null);
    assert.equal(__test.forkParents.has("child"), false);
    assert.equal(__test.historyRewrittenBySession.has("child"), false);
    assert.equal(__test.getSharedSession("parent").sessionId, "parent-cc");
    assert.equal(globalThis[symbol], provider);
  });
  it("refuses to forget an active query", () => {
    const active = { piSessionId: "active" };
    __test.activeQueryContexts.add(active);
    try { assert.throws(() => releaseSession("active"), /still active/); }
    finally { __test.activeQueryContexts.delete(active); }
  });
  it("keeps a live fork gate until the owner starts, then releases all waiters and forgets it", async () => {
    let start;
    const started = new Promise(resolve => { start = resolve; });
    await __test.awaitForkGate("checkpoint", started);
    let entered = false;
    const waiting = __test.awaitForkGate("checkpoint", Promise.resolve()).then(() => { entered = true; });
    await Promise.resolve();
    assert.equal(entered, false);
    assert.equal(__test.forkGates.size, 1);
    start();
    await waiting;
    assert.equal(entered, true);
    assert.equal(__test.forkGates.size, 0);
  });
});
