import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { directory } from "./dataset.js";
import { gradingVersion, judgeProvider } from "./grading-policy.js";
import { loadSavedComparison, savedKey, sha256 } from "./saved-comparison.js";

const review = JSON.parse(readFileSync(resolve(directory, "disputed-review.json"), "utf8"));
const summary = JSON.parse(readFileSync(resolve(directory, "regrade.json"), "utf8"));
assert.equal(review.sourceEvalId, summary.evalId);
assert.equal(review.gradingVersion, gradingVersion);
const native = JSON.parse(
  readFileSync(resolve(directory, "results", summary.runId, "promptfoo.json"), "utf8")
);
assert.equal(
  sha256(readFileSync(resolve(directory, "results", summary.runId, "promptfoo.json"))),
  summary.sourceHashes["promptfoo.json"]
);
const saved = loadSavedComparison();
const tests = (review.disputedKeys as string[]).map((key) => {
  const row = saved.rows.find((r) => savedKey(r) === key);
  assert(row);
  const previous = native.results.results.find(
    (r: { testCase: { vars: { savedKey: string } } }) => r.testCase.vars.savedKey === key
  );
  // Native export redacts some hash-shaped metadata; verify actual output bytes.
  assert.equal(sha256(previous.response.output), sha256(row.response.output));
  // Exact previous rubric: no disagreement hints, proposed labels or reviewer rationales.
  return {
    description: key,
    vars: previous.testCase.vars as { savedKey: string; caseId: string; rubric: string },
    metadata: { ...previous.testCase.metadata, outputSha256: sha256(row.response.output) } as {
      outputSha256: string;
      originalRecordId: string;
    },
  };
});
assert.equal(tests.length, 4);
export default {
  description: "Four disputed saved-output judgments: independent fresh repeat, unchanged rubric",
  prompts: ["{{savedKey}}"],
  providers: [{ id: "file://./saved-output-provider.ts", label: "Saved disputed report" }],
  evaluateOptions: { repeat: 1, maxConcurrency: 2, cache: false },
  defaultTest: {
    assert: [
      { type: "javascript", value: "file://./assertions.ts" },
      {
        type: "llm-rubric",
        value: "{{rubric}}",
        threshold: 1,
        provider: { ...judgeProvider, config: { ...judgeProvider.config, maxRetries: 0 } },
      },
    ],
  },
  tests,
};
