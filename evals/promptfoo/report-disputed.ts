import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { directory } from "./dataset.js";
import { sha256 } from "./saved-comparison.js";
import { priceJudgeUsage } from "./report-judge-calibration.js";

assert(process.argv[2], "Adjudication run directory required");
const runDirectory = resolve(process.argv[2]);
const read = (file: string) => JSON.parse(readFileSync(resolve(runDirectory, file), "utf8"));
const source = JSON.parse(readFileSync(resolve(directory, "regrade.json"), "utf8"));
const events = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const current = events(resolve(runDirectory, "calls.jsonl"));
const previous = events(resolve(directory, "results", source.runId, "calls.jsonl"));
const completed = current.filter((r) => r.phase === "completed");
assert.equal(completed.length, 4);
const authorization = read("authorization.json");
const native = read("promptfoo.json");
const records = completed.map((event) => {
  const earlier = source.records.find((r: { key: string }) => r.key === event.key);
  const result = native.results.results.find(
    (r: { testCase: { vars: { savedKey: string } } }) => r.testCase.vars.savedKey === event.key
  );
  assert.equal(sha256(result.response.output), earlier.outputSha256);
  const bound = authorization.judgeScope.records.find((r: { key: string }) => r.key === event.key);
  assert.equal(sha256(result.testCase.vars.rubric), bound.rubricSha256);
  const claim = current.find((r) => r.key === event.key && r.phase === "started");
  const oldClaim = previous.find((r) => r.key === event.key && r.phase === "started");
  assert.equal(claim.promptSha256, oldClaim.promptSha256, "Repeat judge input changed");
  assert.notEqual(event.response?.cached, true, "Stability repeat must make a fresh call");
  const oldResponse = previous.find((r) => r.key === event.key && r.phase === "completed");
  assert.notEqual(event.response.raw.id, oldResponse.response.raw.id);
  const verdict = event.semanticVerdict?.toLowerCase() ?? "judge_error";
  return {
    key: event.key,
    outputSha256: earlier.outputSha256,
    rubricSha256: bound.rubricSha256,
    originalVerdict: earlier.semanticVerdict,
    repeatedVerdict: verdict,
    agreement: verdict === earlier.semanticVerdict,
    reason: result.gradingResult.componentResults.find(
      (r: { assertion: { type: string } }) => r.assertion.type === "llm-rubric"
    ).reason,
    elapsedMs: event.elapsedMs,
    judgeEstimatedUsd: priceJudgeUsage(event.response.raw.usage),
    fresh: true,
  };
});
const summary = {
  evalId: native.evalId,
  sourceEvalId: source.evalId,
  candidateCalls: 0,
  freshJudgeCalls: 4,
  identicalPrompts: true,
  policyChanged: false,
  originalScoresReplaced: false,
  agreements: records.filter((r) => r.agreement).length,
  disagreements: records.filter((r) => !r.agreement).length,
  incrementalJudgeEstimatedUsd: records.reduce((sum, r) => sum + r.judgeEstimatedUsd, 0),
  timing: read("timing.json"),
  records,
  interpretation:
    "Fresh repeats support stability on four deliberately selected disputes, not accuracy. Keep original grades and provisional selection; independent materiality review remains useful.",
};
writeFileSync(resolve(directory, "disputed-regrade.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
