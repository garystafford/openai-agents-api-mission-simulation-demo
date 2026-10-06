import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { directory, loadCase } from "./dataset.js";
import { loadReferenceBundle } from "./reference-artifacts.js";
import { buildRubric, gradingVersion, judgeProvider } from "./grading-policy.js";
import { loadSavedComparison, savedKey, sha256 } from "./saved-comparison.js";

const saved = loadSavedComparison();
const references = loadReferenceBundle();
const offline = JSON.parse(
  readFileSync(resolve(directory, "calibration/offline-review.json"), "utf8")
);
assert.equal(offline.sourceEvalId, saved.evalId, "Wrong offline calibration source");
assert.equal(offline.gradingVersion, gradingVersion, "Stale grading version");
assert.equal(offline.rawResult.sha256, saved.rawResult.sha256, "Wrong saved-output export");
for (const [file, hash] of Object.entries(offline.artifactsSha256))
  assert.equal(
    sha256(readFileSync(resolve(directory, file))),
    hash,
    "Calibration artifact changed; rerun the offline review before any regrade: " + file
  );
const rubricBindings = new Map<string, string>(
  offline.records.map((row: { key: string; rubricSha256: string }) => [row.key, row.rubricSha256])
);
export default {
  description:
    "HELD: " + gradingVersion + " judge-only regrade of 135 saved outputs; no candidate sessions",
  prompts: ["{{savedKey}}"],
  providers: [{ id: "file://./saved-output-provider.ts", label: "Saved candidate episode" }],
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
  tests: saved.rows.map((row) => {
    const item = loadCase(row.testCase.vars.caseId);
    const rubric = buildRubric(item, references?.answers.get(item.id)?.answer);
    assert.equal(
      sha256(rubric),
      rubricBindings.get(savedKey(row)),
      "Rubric drift after offline review"
    );
    return {
      description: savedKey(row),
      vars: {
        savedKey: savedKey(row),
        caseId: item.id,
        rubric,
      },
      metadata: {
        gradingVersion,
        originalEvalId: saved.evalId,
        originalRecordId: row.id,
        originalProvider: row.provider.id,
        outputSha256: sha256(row.response.output),
        role: item.record.role,
        scenario: item.replay?.state.scenario.id ?? item.record.state.scenario.id,
      },
    };
  }),
};
