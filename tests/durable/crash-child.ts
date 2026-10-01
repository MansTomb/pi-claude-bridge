import { join } from "node:path";
import { context, diceTable, GAME_MASTER, MODEL, openTable } from "./harness.ts";

const [scenario, dir] = process.argv.slice(2);
const db = join(dir, "table.sqlite");

if (scenario === "tool") {
  const { harness } = await openTable(db, { extensions: [diceTable(join(dir, "ledger.json"), true)] });
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off", instructions: GAME_MASTER } });
  await root.submit({ type: "input", content: "I try to climb the wall. Roll for it.", requestId: "turn-1" }, context);
  await root.waitForIdle(context);
}

if (scenario === "stream") {
  const { harness } = await openTable(db);
  const root = await harness.root(context, { agent: { model: MODEL, thinkingLevel: "off" } });
  const view = await root.viewState(context);
  view.subscribe((value: any) => {
    const partial = JSON.stringify(value.docs?.["pi.live"]?.generation?.message ?? "");
    if (partial.length > 400) process.kill(process.pid, "SIGKILL");
  });
  await root.submit({ type: "input", content: "Describe a tavern in about 250 words.", requestId: "turn-1" }, context);
  await root.waitForIdle(context);
}

process.exit(3);
