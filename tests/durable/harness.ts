import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRegistry, defineExtension, defineTool, Harness, type Extension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import bridgeFactory from "./.bridge/src/index.ts";

export const context = BACKGROUND_CONTEXT;
export const MODEL = { provider: "claude-bridge", modelId: process.env.BRIDGE_TEST_MODEL ?? "claude-sonnet-5-5" };

export const scratch = (name: string) => mkdtempSync(join(tmpdir(), `bridge-durable-${name}-`));

let bridgeProvider: Promise<any> | undefined;

function loadBridgeProvider(): Promise<any> {
  bridgeProvider ??= (async () => {
    let providerConfig: any;
    const pi: any = new Proxy(
      { on: () => {}, registerProvider: (_id: string, config: unknown) => (providerConfig = config) },
      { get: (target: any, key) => (key in target ? target[key] : () => undefined) },
    );
    await bridgeFactory(pi);
    if (!providerConfig) throw new Error("the bridge registered no provider");
    return providerConfig;
  })();
  return bridgeProvider;
}

export async function openTable(
  db: string,
  options: { extensions?: Extension[]; settings?: object } = {},
) {
  const models = await ModelRuntime.create();
  models.registerProvider("claude-bridge", await loadBridgeProvider());
  const registry = createRegistry();
  for (const extension of options.extensions ?? []) registry.install(extension);
  const harness = await Harness.open(
    await openNodeSqliteStorage(db),
    { models, registry, settings: options.settings as any },
    context,
  );
  return { harness, models };
}

export type Ledger = Array<{ taskId: string; roll: number }>;
export const readLedger = (file: string): Ledger => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);

export function diceTable(ledgerFile: string, killAfterEffect: boolean): Extension {
  const rollDice = defineTool({
    name: "roll_dice",
    description: "Roll a d20 for the player. Applies the roll to the game world.",
    parameters: Type.Object({ reason: Type.String() }),
    replay: "safe",
    execute: async (_args, api) => {
      const taskId = String(api.taskId);
      const ledger = readLedger(ledgerFile);
      const applied = ledger.find((entry) => entry.taskId === taskId);
      if (applied) return { content: [{ type: "text", text: `d20 = ${applied.roll}` }] };
      const roll = 1 + Math.floor(Math.random() * 20);
      writeFileSync(ledgerFile, JSON.stringify([...ledger, { taskId, roll }]));
      if (killAfterEffect) process.kill(process.pid, "SIGKILL");
      return { content: [{ type: "text", text: `d20 = ${roll}` }] };
    },
  });
  return defineExtension({ name: "table", tools: [rollDice] });
}

export const GAME_MASTER =
  "You are a terse tabletop game master. When the player asks for a roll, call roll_dice exactly once, then report the number in one short sentence.";

export function killedChild(scenario: string, dir: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "crash-child.ts", scenario, dir], {
    cwd: import.meta.dirname,
    encoding: "utf8",
    timeout: 240_000,
  });
}

export function entryText(entry: any): string {
  const message = entry.model?.[0];
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return (message.content ?? [])
    .filter((block: any) => block.type === "text")
    .map((block: any) => block.text)
    .join("")
    .trim();
}

export async function entries(conversation: any): Promise<any[]> {
  const view = await conversation.viewState(context);
  const value = (view.value as any).entries;
  view.dispose();
  return value;
}

export const assistants = (list: any[]) => list.filter((entry) => entry.kind === "pi.assistant");
export const session = (entry: any) => entry.model?.[0]?.claudeCodeSession;
