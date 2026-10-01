import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  assistants,
  context,
  diceTable,
  entries,
  entryText,
  GAME_MASTER,
  killedChild,
  MODEL,
  openTable,
  readLedger,
  scratch,
  session,
} from "./harness.ts";

describe("a pi-durable turn on the bridge survives the host dying", () => {
  it("a restart while a replay-safe tool runs applies its effect once and finishes the turn", async () => {
    const dir = scratch("tool");
    const child = killedChild("tool", dir);
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const [effect] = readLedger(join(dir, "ledger.json"));
    assert.ok(effect, "the killed process applied the roll before dying");

    const { harness } = await openTable(join(dir, "table.sqlite"), {
      extensions: [diceTable(join(dir, "ledger.json"), false)],
    });
    const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off", instructions: GAME_MASTER } });
    harness.resume();
    const settled = await (
      await root.submit({ type: "input", content: "I try to climb the wall. Roll for it.", requestId: "turn-1" }, context)
    ).wait(context);
    const list = await entries(root);
    await harness.close(context);

    assert.equal(settled.status, "done");
    assert.deepEqual(readLedger(join(dir, "ledger.json")), [effect]);
    assert.equal(list.filter((entry) => entry.kind === "pi.tool-result").length, 1);
    const answer = assistants(list).at(-1);
    assert.match(entryText(answer), new RegExp(`\\b${effect.roll}\\b`));
    assert.equal(session(answer).sync, "rebuild");
  });

  it("a restart while the answer streams resends the request and keeps the partial as aborted", async () => {
    const dir = scratch("stream");
    const child = killedChild("stream", dir);
    assert.equal(child.signal, "SIGKILL", child.stderr);

    const { harness } = await openTable(join(dir, "table.sqlite"));
    const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
    harness.resume();
    const settled = await (
      await root.submit({ type: "input", content: "Describe a tavern in about 250 words.", requestId: "turn-1" }, context)
    ).wait(context);
    const replies = assistants(await entries(root));
    await harness.close(context);

    assert.equal(settled.status, "done");
    assert.deepEqual(
      replies.map((entry) => entry.model[0].stopReason),
      ["aborted", "stop"],
    );
    assert.ok(entryText(replies[1]).split(/\s+/).length > 150, entryText(replies[1]));
  });
});
