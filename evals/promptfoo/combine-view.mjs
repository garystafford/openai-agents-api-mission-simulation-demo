// Offline presentation only: join saved judgments onto the native candidate matrix.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";

const [directory, candidateFile = "power.promptfoo.json"] = process.argv.slice(2);
assert(directory, "Usage: node combine-view.mjs RUN_DIRECTORY [CANDIDATE_FILE]");
const read = (file) => JSON.parse(readFileSync(resolve(directory, file), "utf8"));
const hash = (file) =>
  createHash("sha256")
    .update(readFileSync(resolve(directory, file)))
    .digest("hex");
const candidate = read(candidateFile);
const judge = read("judge.promptfoo.json");
const view = structuredClone(candidate);
const key = (row) => row.testCase.vars.caseId + "::" + row.provider.id;
const judgments = new Map(judge.results.results.map((row) => [row.testCase.vars.savedKey, row]));
assert.equal(judgments.size, judge.results.results.length, "Duplicate judge keys");
assert.equal(new Set(view.results.results.map(key)).size, view.results.results.length);
let joined = 0;
for (const row of view.results.results) {
  const judgment = judgments.get(key(row));
  if (judgment) {
    assert.equal(row.response.output, judgment.response.output, "Answer mismatch: " + key(row));
    for (const field of [
      "gradingResult",
      "score",
      "success",
      "failureReason",
      "error",
      "namedScores",
    ]) {
      delete row[field];
      if (field in judgment) row[field] = structuredClone(judgment[field]);
    }
    row.testCase.assert = structuredClone(judgment.testCase.assert);
    row.testCase.vars.rubric = judgment.testCase.vars.rubric;
    row.tokenUsage.assertions = structuredClone(judgment.gradingResult.tokensUsed);
    joined++;
  } else {
    assert(!row.success && !row.response?.output, "Missing judgment for an answer: " + key(row));
  }
  row.id = randomUUID();
}
function sumUsage(usages) {
  const result = {};
  for (const usage of usages)
    for (const [key, value] of Object.entries(usage ?? {})) {
      if (typeof value === "number") result[key] = (result[key] ?? 0) + value;
      else if (value && typeof value === "object") result[key] = sumUsage([result[key], value]);
    }
  return result;
}
for (let index = 0; index < view.results.prompts.length; index++) {
  const prompt = view.results.prompts[index];
  const rows = view.results.results.filter((row) => row.promptIdx === index);
  const components = rows.flatMap((row) => row.gradingResult?.componentResults ?? []);
  Object.assign(prompt.metrics, {
    score: rows.reduce((total, row) => total + row.score, 0),
    testPassCount: rows.filter((row) => row.success).length,
    testFailCount: rows.filter((row) => !row.success && row.failureReason !== 2).length,
    testErrorCount: rows.filter((row) => row.failureReason === 2).length,
    assertPassCount: components.filter((part) => part.pass).length,
    assertFailCount: components.filter((part) => !part.pass).length,
    tokenUsage: sumUsage(rows.map((row) => row.tokenUsage)),
  });
}
view.results.stats.successes = view.results.results.filter((row) => row.success).length;
view.results.stats.errors = view.results.results.filter((row) => row.failureReason === 2).length;
view.results.stats.failures =
  view.results.results.length - view.results.stats.successes - view.results.stats.errors;
view.results.stats.tokenUsage = sumUsage(view.results.results.map((row) => row.tokenUsage));
view.config.description =
  "FINAL COMPARISON — " +
  candidate.config.description.replace("Frozen focused model comparison: ", "") +
  " — saved outputs + final grades (offline view)";
view.config.defaultTest.assert = structuredClone(judge.config.defaultTest.assert);
view.metadata = {
  ...view.metadata,
  derivedOffline: true,
  candidateEvalId: candidate.evalId,
  judgeEvalId: judge.evalId,
  candidateSha256: hash(candidateFile),
  judgeSha256: hash("judge.promptfoo.json"),
  note: "Presentation only; no new inference or grading. Candidate latency/cost retained; judge cost is reported separately in the published decision. Scores retain native aggregation; complete pass requires both checks.",
};
view.config.metadata = { ...view.config.metadata, ...view.metadata };
delete view.evalId;
view.results.timestamp = new Date().toISOString();
const output = resolve(
  directory,
  candidateFile.replace(".promptfoo.json", ".combined.promptfoo.json")
);
writeFileSync(output, JSON.stringify(view, null, 2) + "\n", { flag: "wx" });
console.log(
  JSON.stringify({
    output,
    joined,
    cells: view.results.results.length,
    completePasses: view.results.stats.successes,
    columns: view.results.prompts.map((prompt) => prompt.provider),
    apiCalls: 0,
  })
);
