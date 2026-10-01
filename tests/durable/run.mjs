import { spawnSync } from "node:child_process";
import { cpSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
rmSync(join(here, ".bridge"), { recursive: true, force: true });
cpSync(join(here, "../../src"), join(here, ".bridge/src"), { recursive: true });

const only = process.argv.slice(2);
const files = readdirSync(here)
  .filter((file) => file.endsWith(".test.ts"))
  .filter((file) => only.length === 0 || only.some((name) => file.includes(name)));
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...files], {
  cwd: here,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
