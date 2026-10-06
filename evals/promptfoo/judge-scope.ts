import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { directory } from "./dataset.js";
import { sha256 } from "./saved-comparison.js";
import { priceJudgeUsage } from "./report-judge-calibration.js";

export type JudgeScope = {
  kind?: "calibration" | "regrade" | "validation" | "adjudication" | "focused";
  runId: string;
  expiresAt: string;
  maxCalls: number;
  estimatedBudgetUsd?: number;
  records: Array<{ key: string; outputSha256: string; rubricSha256: string }>;
};

export function validateJudgeScope(
  scope: JudgeScope,
  vars: Record<string, unknown> | undefined,
  runId: string | undefined,
  startedKeys: string[],
  now = Date.now()
) {
  assert.equal(runId, scope.runId, "Judge run authorization mismatch");
  assert(
    Number.isFinite(Date.parse(scope.expiresAt)) && now < Date.parse(scope.expiresAt),
    "Judge authorization expired"
  );
  const expected =
    scope.kind === "validation" || scope.kind === "adjudication" || scope.kind === "focused"
      ? scope.records.length
      : scope.kind === "regrade"
        ? 135
        : 27;
  if (scope.kind === "adjudication")
    assert(expected >= 1 && expected <= 27, "Adjudication judge bound exceeded");
  if (scope.kind === "validation")
    assert(expected >= 1 && expected <= 128, "Validation judge bound exceeded");
  if (scope.kind === "focused")
    assert(expected >= 1 && expected <= 54, "Focused judge bound exceeded");
  assert.equal(scope.maxCalls, expected, "Wrong bounded judge call count");
  assert.equal(scope.records.length, expected, "Wrong bounded judge record count");
  assert.equal(
    new Set(scope.records.map((r) => r.key)).size,
    expected,
    "Duplicate authorized record"
  );
  const key = vars?.savedKey;
  assert(typeof key === "string", "Missing saved-output identity");
  const row = scope.records.find((record) => record.key === key);
  assert(row, "Output is outside authorized calibration subset");
  assert(
    !startedKeys.includes(key),
    "Judge call already attempted for this example; retries require authorization"
  );
  assert(startedKeys.length < scope.maxCalls, "Judge call limit reached");
  assert.equal(
    sha256(JSON.stringify(vars?.output)),
    row.outputSha256,
    "Judge output differs from authorized saved output"
  );
  assert.equal(
    sha256(String(vars?.rubric)),
    row.rubricSha256,
    "Judge rubric differs from authorized policy"
  );
  return key;
}

// Synchronous claim before awaiting the API: concurrency cannot duplicate a key.
// The launcher owns the journal directory and closes authorization in finally.
export function claimJudgeCall(
  policy: { judgeScope?: JudgeScope },
  prompt: string,
  vars: Record<string, unknown> | undefined,
  config: Record<string, unknown> | undefined
) {
  if (!policy.judgeScope) return undefined;
  assert.equal(config?.maxRetries, 0, "Calibration must disable native API retries");
  const scope = policy.judgeScope;
  assert.match(
    scope.runId,
    /^judge-(calibration|regrade|validation|adjudication|focused)-[0-9TZ-]+$/
  );
  const runDirectory = resolve(directory, "results", scope.runId);
  const journal = resolve(runDirectory, "calls.jsonl");
  const previous = readFileSync(journal, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const key = validateJudgeScope(
    scope,
    vars,
    process.env.MARS_JUDGE_CALIBRATION_RUN,
    previous.filter((event) => event.phase === "started").map((event) => event.key)
  );
  if (scope.kind === "focused") {
    assert(Number.isFinite(scope.estimatedBudgetUsd), "Focused judge budget required");
    const committed = previous
      .filter((event) => event.phase === "started")
      .reduce((sum, event) => {
        const completed = previous.find(
          (row) => row.phase === "completed" && row.key === event.key
        );
        return (
          sum +
          (completed?.response?.raw?.usage ? priceJudgeUsage(completed.response.raw.usage) : 0.12)
        );
      }, 0);
    assert(
      committed + 0.12 <= scope.estimatedBudgetUsd!,
      "Focused judge estimated budget stop reached"
    );
  }
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const index = previous.filter((event) => event.phase === "started").length;
  writeFileSync(resolve(runDirectory, `prompt-${index}.json`), prompt + "\n");
  appendFileSync(
    journal,
    JSON.stringify({
      phase: "started",
      key,
      startedAt,
      promptSha256: sha256(prompt),
      promptFile: `prompt-${index}.json`,
    }) + "\n"
  );
  return (result: Record<string, unknown>) => {
    appendFileSync(
      journal,
      JSON.stringify({
        phase: "completed",
        key,
        startedAt,
        completedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedMs,
        ...result,
      }) + "\n"
    );
    console.log(
      `Judge calibration completed: ${key} (${((Date.now() - startedMs) / 1000).toFixed(1)}s)`
    );
  };
}
