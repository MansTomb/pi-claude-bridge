import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CompactionTask, defineExtension, hook } from "@earendil-works/pi-durable";
import { assistants, context, entries, entryText, MODEL, openTable, scratch } from "./harness.ts";

const HANDOFF_WRITING_MS = 25_000;

describe("a host-written handoff replaces old context while play goes on", () => {
  it("turns played while the handoff is written stay verbatim after it and are not delayed", async () => {
    const timeline: string[] = [];
    let window = 0;
    const Handoff = defineExtension({
      name: "handoff",
      hooks: [
        hook(CompactionTask, {
          beforeCompact: async () => {
            timeline.push("handoff started");
            await new Promise((resolve) => setTimeout(resolve, HANDOFF_WRITING_MS));
            timeline.push("handoff finished");
            return { summary: "HANDOFF: The vault password is copper-owl. The player character is Bran the dwarf." };
          },
        }),
      ],
    });
    const settings = {
      get compaction() {
        return { reserveTokens: window - 9000, backgroundTokens: 7600, keepRecentTokens: 10 };
      },
    };
    const { harness, models } = await openTable(join(scratch("handoff"), "table.sqlite"), {
      extensions: [Handoff],
      settings,
    });
    window = models.getModel("claude-bridge", MODEL.modelId)!.contextWindow;
    const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
    const durations: number[] = [];
    const play = async (content: string) => {
      const start = Date.now();
      const settled = await (await root.submit({ type: "input", content }, context)).wait(context);
      durations.push(Date.now() - start);
      timeline.push(`turn ${durations.length}`);
      assert.equal(settled.status, "done");
    };

    await play("The vault password is copper-owl. My character is Bran the dwarf. Reply only: OK.");
    await play("I open the tavern door. One sentence.");
    await play("I order an ale. One sentence.");
    await play("I sit by the fire. One sentence.");
    while (!timeline.includes("handoff finished")) await new Promise((resolve) => setTimeout(resolve, 500));
    await root.waitForIdle(context);
    await play("What is the vault password? One word.");
    const list = await entries(root);
    await harness.close(context);

    assert.deepEqual(timeline, [
      "turn 1",
      "handoff started",
      "turn 2",
      "turn 3",
      "turn 4",
      "handoff finished",
      "turn 5",
    ]);
    for (const duration of durations.slice(1, 4)) assert.ok(duration < HANDOFF_WRITING_MS / 2, `${duration}ms`);
    assert.equal(list[0].kind, "pi.compaction");
    assert.match(entryText(list[0]), /HANDOFF: The vault password is copper-owl/);
    assert.deepEqual(
      list.filter((entry) => entry.kind === "pi.user").map(entryText),
      [
        "I open the tavern door. One sentence.",
        "I order an ale. One sentence.",
        "I sit by the fire. One sentence.",
        "What is the vault password? One word.",
      ],
    );
    assert.match(entryText(assistants(list).at(-1)), /copper-owl/);
  });
});
