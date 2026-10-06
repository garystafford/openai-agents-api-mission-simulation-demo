import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { assertComparisonReleased } from "./execution-policy.js";
assertComparisonReleased();
if (!process.argv.includes("--live"))
  throw new Error("Paid comparison is disabled. Explicitly pass --live when authorized.");
mkdirSync("evals/promptfoo/results", { recursive: true });
const result = spawnSync(
  process.execPath,
  [
    "node_modules/promptfoo/dist/src/entrypoint.js",
    "eval",
    "--config",
    "evals/promptfoo/promptfooconfig.ts",
    "--no-cache",
    "--output",
    "evals/promptfoo/results/" + new Date().toISOString().replaceAll(":", "-") + ".json",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      MARS_PROMPTFOO_LIVE: "1",
      PROMPTFOO_DISABLE_TELEMETRY: "1",
      PROMPTFOO_CONFIG_DIR: resolve("evals/promptfoo/.promptfoo"),
    },
  }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
