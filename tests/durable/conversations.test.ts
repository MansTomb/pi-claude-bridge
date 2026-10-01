import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { assistants, context, entries, entryText, MODEL, openTable, scratch, session } from "./harness.ts";

const ask = async (conversation: any, content: string) =>
  (await conversation.submit({ type: "input", content }, context)).wait(context);

describe("pi-durable conversations on the bridge", () => {
  it("a fork and its parent answer in parallel from their own Claude Code sessions", async () => {
    const { harness } = await openTable(join(scratch("fork"), "table.sqlite"));
    const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
    await ask(root, "My character is Bran the dwarf. The vault password is copper-owl. Reply only: OK.");
    const forkPoint = (await entries(root)).at(-1).id;
    const fork = await root.fork(forkPoint, { ownership: { kind: "ownerless" } }, context);

    const [rootTurn, forkTurn] = await Promise.all([
      ask(root, "What is my character's name? One word."),
      ask(fork, "What is the vault password? One word."),
    ]);
    const rootAnswer = assistants(await entries(root)).at(-1);
    const forkAnswer = assistants(await entries(fork)).at(-1);
    await harness.close(context);

    assert.equal(rootTurn.status, "done");
    assert.equal(forkTurn.status, "done");
    assert.match(entryText(rootAnswer), /Bran/);
    assert.match(entryText(forkAnswer), /copper-owl/);
    assert.notEqual(session(rootAnswer).resumedSessionId, session(forkAnswer).resumedSessionId);
  });

  it("a manual compaction summarized by the bridge carries the facts into the next turn", async () => {
    const { harness } = await openTable(join(scratch("compact"), "table.sqlite"), {
      settings: { compaction: { keepRecentTokens: 10 } },
    });
    const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
    await ask(root, "The vault password is copper-owl. Reply only: OK.");
    await ask(root, "My character is Bran the dwarf. Reply only: OK.");
    const compaction = await harness.waitForTask(
      await root.compact("Keep the vault password and the character name.", context),
      context,
    );
    const turn = await ask(root, "What are the vault password and my character's name? One line.");
    const list = await entries(root);
    await harness.close(context);

    assert.equal((compaction as any).state.outcome.status, "completed");
    assert.equal(list[0].kind, "pi.compaction");
    assert.equal(turn.status, "done");
    const answer = assistants(list).at(-1);
    assert.match(entryText(answer), /copper-owl/);
    assert.match(entryText(answer), /Bran/);
    assert.equal(session(answer).sync, "rebuild");
  });

  it("an abort mid-answer settles the conversation idle and the next turn answers", async () => {
    const { harness } = await openTable(join(scratch("abort"), "table.sqlite"));
    const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
    const view = await root.viewState(context);
    let aborted: Promise<void> | undefined;
    view.subscribe((value: any) => {
      const partial = JSON.stringify(value.docs?.["pi.live"]?.generation?.message ?? "");
      if (partial.length > 400) aborted ??= root.abort(context);
    });
    const long = await ask(root, "Describe a tavern in about 250 words.");
    await aborted;
    view.dispose();
    const next = await ask(root, "Reply only: OK.");
    const replies = assistants(await entries(root));
    await harness.close(context);

    assert.ok(aborted, "the answer streamed far enough to abort");
    assert.deepEqual([long.status, (long as any).reason], ["unanswered", "aborted"]);
    assert.equal(next.status, "done");
    assert.deepEqual(
      replies.map((entry) => entry.model[0].stopReason),
      ["aborted", "stop"],
    );
    assert.match(entryText(replies[1]), /OK/);
  });
});
