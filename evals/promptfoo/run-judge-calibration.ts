import "../../server/env.js";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { directory } from "./dataset.js";
import { gradingVersion } from "./grading-policy.js";
import { sha256 } from "./saved-comparison.js";

assert(process.argv.includes("--live"), "Explicit --live required for paid judge calibration");
assert(process.env.OPENAI_API_KEY, "Existing API key is unavailable");
const policyPath = resolve(directory, "execution-policy.json");
const previousPolicy = JSON.parse(readFileSync(policyPath, "utf8"));
const alongsideValidation =
  process.argv.includes("--disputed") &&
  previousPolicy.status === "released" &&
  previousPolicy.allowedOperations?.length === 1 &&
  previousPolicy.allowedOperations[0] === "candidate" &&
  previousPolicy.validationScope?.maxMissions === 10;
assert(
  previousPolicy.status === "on_hold" || alongsideValidation,
  "Another paid operation is already released"
);
const full = process.argv.includes("--full");
const validationIndex = process.argv.indexOf("--validation");
const validation = validationIndex >= 0;
const disputed = process.argv.includes("--disputed");
assert(Number(full) + Number(validation) + Number(disputed) <= 1, "Choose one judge phase");
if (validation) {
  assert(process.argv[validationIndex + 1], "Validation run directory required");
  process.env.MARS_VALIDATION_DIRECTORY = resolve(process.argv[validationIndex + 1]);
  const { prepareValidationCases } = await import("./validation-cases.js");
  prepareValidationCases(process.env.MARS_VALIDATION_DIRECTORY);
}
const kind = disputed
  ? "adjudication"
  : validation
    ? "validation"
    : full
      ? "regrade"
      : "calibration";
const { default: config } = disputed
  ? await import("./disputed-config.js")
  : validation
    ? await import("./validation-config.js")
    : full
      ? await import("./regrade-config.js")
      : await import("./judge-calibration-config.js");
const expected = disputed || validation ? config.tests.length : full ? 135 : 27;
assert(expected >= 1 && expected <= 135);
assert.equal(config.tests.length, expected);
const preflight = (await import("node:child_process")).spawnSync(
  process.execPath,
  ["node_modules/promptfoo/dist/src/entrypoint.js", "--version"],
  {
    encoding: "utf8",
    env: {
      ...process.env,
      PROMPTFOO_DISABLE_TELEMETRY: "1",
      PROMPTFOO_CONFIG_DIR: resolve(directory, ".promptfoo"),
    },
  }
);
assert.equal(preflight.status, 0, "Native Promptfoo CLI preflight failed before paid release");
const offline = JSON.parse(
  readFileSync(resolve(directory, "calibration/offline-review.json"), "utf8")
);
const runId =
  "judge-" +
  kind +
  "-" +
  new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d+Z$/, "Z");
const runDirectory = resolve(directory, "results", runId);
mkdirSync(runDirectory, { recursive: false });
writeFileSync(resolve(runDirectory, "calls.jsonl"), "");
copyFileSync(
  resolve(directory, "calibration/anchors.json"),
  resolve(runDirectory, "anchors.snapshot.json")
);
copyFileSync(
  resolve(directory, "calibration/offline-review.json"),
  resolve(runDirectory, "offline-review.snapshot.json")
);
copyFileSync(
  resolve(directory, "calibration/label-amendments.json"),
  resolve(runDirectory, "label-amendments.snapshot.json")
);
const startedAt = new Date().toISOString();
const startedMs = Date.now();
const authorization = {
  ...previousPolicy,
  status: "released",
  allowedOperations: ["judge"],
  reason:
    "User authorized bounded judge-only " +
    kind +
    " of saved outputs; no candidate sessions in this phase.",
  judgeScope: {
    kind,
    runId,
    expiresAt: new Date(Date.now() + 45 * 60 * 1000).toISOString(),
    maxCalls: expected,
    records: config.tests.map((test) => ({
      key: test.vars.savedKey,
      outputSha256: test.metadata.outputSha256,
      rubricSha256: sha256(test.vars.rubric),
    })),
  },
};
writeFileSync(
  resolve(runDirectory, "authorization.json"),
  JSON.stringify(authorization, null, 2) + "\n"
);
writeFileSync(
  resolve(runDirectory, "manifest.json"),
  JSON.stringify(
    {
      runId,
      startedAt,
      gradingVersion,
      kind,
      labelRevision: "materiality-v3-labels-r2",
      sourceEvalId: offline.sourceEvalId,
      anchorsSha256: sha256(readFileSync(resolve(directory, "calibration/anchors.json"))),
      offlineReviewSha256: sha256(
        readFileSync(resolve(directory, "calibration/offline-review.json"))
      ),
      model: "gpt-6-sol",
      reasoning: "medium",
      maxOutputTokens: 4096,
      concurrency: 2,
      repeats: 1,
      candidateCalls: 0,
      validationDirectory: validation ? process.env.MARS_VALIDATION_DIRECTORY : undefined,
      validationCasesSha256: validation
        ? sha256(readFileSync(resolve(process.env.MARS_VALIDATION_DIRECTORY!, "cases.json")))
        : undefined,
      plannedJudgeCalls: expected,
    },
    null,
    2
  ) + "\n"
);
let child: ReturnType<typeof spawn> | undefined;
let interrupted = false;
const restore = () => {
  if (!alongsideValidation)
    writeFileSync(policyPath, JSON.stringify(previousPolicy, null, 2) + "\n");
};
const stop = () => {
  interrupted = true;
  restore();
  child?.kill("SIGTERM");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
let exitCode: number | null = null;
try {
  if (!alongsideValidation)
    writeFileSync(policyPath, JSON.stringify(authorization, null, 2) + "\n");
  console.log(
    JSON.stringify({
      runId,
      examples: expected,
      candidateCalls: 0,
      judge: "gpt-6-sol / medium",
      concurrency: 2,
    })
  );
  child = spawn(
    process.execPath,
    [
      "node_modules/promptfoo/dist/src/entrypoint.js",
      "eval",
      "--config",
      disputed
        ? "evals/promptfoo/disputed-config.ts"
        : validation
          ? "evals/promptfoo/validation-config.ts"
          : full
            ? "evals/promptfoo/regrade-config.ts"
            : "evals/promptfoo/judge-calibration-config.ts",
      "--no-cache",
      "--output",
      resolve(runDirectory, "promptfoo.json"),
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        MARS_PROMPTFOO_LIVE: "1",
        MARS_JUDGE_CALIBRATION_RUN: runId,
        MARS_JUDGE_AUTHORIZATION_FILE: alongsideValidation
          ? resolve(runDirectory, "authorization.json")
          : undefined,
        PROMPTFOO_DISABLE_TELEMETRY: "1",
        PROMPTFOO_CACHE_ENABLED: "false",
        PROMPTFOO_CONFIG_DIR: resolve(directory, ".promptfoo"),
        REQUEST_TIMEOUT_MS: "300000",
        LOG_LEVEL: "info",
      },
    }
  );
  exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child!.once("error", reject);
    child!.once("exit", resolveExit);
  });
} finally {
  restore();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  writeFileSync(
    resolve(runDirectory, "timing.json"),
    JSON.stringify(
      {
        startedAt,
        completedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedMs,
        exitCode,
        interrupted,
        paidStatus: alongsideValidation
          ? "judge permit completed; separate mission validation continues"
          : "on_hold",
      },
      null,
      2
    ) + "\n"
  );
  console.log(
    (alongsideValidation
      ? "Bounded judge permit completed; separate mission validation policy preserved. Run artifacts: "
      : "Paid candidate and judge operations restored to on_hold. Run artifacts: ") + runDirectory
  );
}
// Promptfoo commonly exits nonzero for assertion disagreements; inspect saved artifacts, never retry automatically.
process.exitCode = exitCode ?? 1;
