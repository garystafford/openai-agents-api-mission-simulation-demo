import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { directory, loadCase, loadManifest } from "./dataset.js";
import { gradeEpisode } from "./assertions.js";
import {
  boundaryRules,
  buildRubric,
  caseGradingContract,
  gradingVersion,
} from "./grading-policy.js";
import { loadReferenceBundle } from "./reference-artifacts.js";
import { loadSavedComparison, savedKey, sha256, type SavedRow } from "./saved-comparison.js";

export const anchorSchema = z.object({
  key: z.string(),
  recordId: z.string(),
  outputSha256: z.string(),
  semanticVerdict: z.enum(["pass", "fail", "needs_review"]),
  issue: z.string().min(1),
  candidateEvidence: z.string().min(1),
  factualBasis: z.string().min(1),
  rationale: z.string().min(1),
  workflow: z.array(z.string()),
});
export type CalibrationAnchor = z.infer<typeof anchorSchema>;

export function validateAnchors(anchors: CalibrationAnchor[], rows: SavedRow[]) {
  const byKey = new Map(rows.map((row) => [savedKey(row), row]));
  assert.equal(new Set(anchors.map((a) => a.key)).size, anchors.length, "Duplicate anchor");
  for (const anchor of anchors) {
    const row = byKey.get(anchor.key);
    assert(row, "Anchor not in source sweep");
    assert.equal(anchor.recordId, row.id, "Anchor native ID is stale");
    assert.equal(
      anchor.outputSha256,
      sha256(row.response.output),
      "Anchor output binding is stale"
    );
    // Quotes bind rationale to actual final content, not an old judge's summary.
    const answer = JSON.stringify(JSON.parse(row.response.output).answer);
    assert(
      answer.includes(anchor.candidateEvidence),
      "Anchor quote not in candidate final answer: " + anchor.key
    );
  }
}

export function buildOfflineReview() {
  const saved = loadSavedComparison();
  const anchorsBytes = readFileSync(resolve(directory, "calibration/anchors.json"));
  const anchorDocument = z
    .object({
      sourceEvalId: z.string(),
      version: z.literal(gradingVersion),
      status: z.literal("finalized_offline"),
      independentHumanApproval: z.literal(false),
      anchors: z.array(anchorSchema),
    })
    .parse(JSON.parse(anchorsBytes.toString()));
  assert.equal(anchorDocument.sourceEvalId, saved.evalId);
  validateAnchors(anchorDocument.anchors, saved.rows);
  const anchors = new Map(anchorDocument.anchors.map((anchor) => [anchor.key, anchor]));
  const adjudications = z
    .object({
      version: z.literal(gradingVersion),
      status: z.literal("finalized_offline"),
      sourceEvalId: z.string(),
      independentHumanApproval: z.literal(false),
      previousArtifactsSha256: z.record(z.string(), z.string()),
      decisions: z
        .array(
          anchorSchema.omit({ issue: true, workflow: true }).extend({
            previousVerdict: z.literal("needs_review"),
            semanticVerdict: z.enum(["pass", "fail"]),
            ruleId: z.string(),
          })
        )
        .length(4),
    })
    .parse(JSON.parse(readFileSync(resolve(directory, "calibration/adjudications.json"), "utf8")));
  assert.equal(adjudications.sourceEvalId, saved.evalId);
  assert.equal(
    new Set(adjudications.decisions.map((d) => d.key)).size,
    4,
    "Duplicate adjudication"
  );
  for (const [file, hash] of Object.entries(adjudications.previousArtifactsSha256)) {
    assert(
      [
        "anchors.json",
        "contracts.json",
        "offline-review.json",
        "grading-policy.ts",
        "held-judge.ts",
      ].includes(file),
      "Unknown archived grading artifact"
    );
    assert.equal(
      sha256(readFileSync(resolve(directory, "calibration/history/materiality-v2", file))),
      hash,
      "Prior calibration history changed"
    );
  }
  for (const decision of adjudications.decisions) {
    const anchor = anchors.get(decision.key);
    assert(anchor, "Adjudication lacks an anchor");
    assert(
      boundaryRules.some((rule) => rule.id === decision.ruleId),
      "Unknown adjudication rule"
    );
    for (const field of [
      "recordId",
      "outputSha256",
      "semanticVerdict",
      "candidateEvidence",
      "factualBasis",
      "rationale",
    ] as const)
      assert.equal(decision[field], anchor[field], "Adjudication and anchor disagree: " + field);
  }
  const amendment = JSON.parse(
    readFileSync(resolve(directory, "calibration/label-amendments.json"), "utf8")
  );
  assert.equal(amendment.gradingVersion, gradingVersion);
  assert.equal(amendment.policyChanged, false);
  const previousAnchors = readFileSync(
    resolve(directory, "calibration/history/materiality-v3-pilot/anchors.json")
  );
  assert.equal(sha256(previousAnchors), amendment.previousAnchorsSha256);
  const previousLabels = new Map(
    JSON.parse(previousAnchors.toString()).anchors.map((a: CalibrationAnchor) => [
      a.key,
      a.semanticVerdict,
    ])
  );
  assert.equal(amendment.amendments.length, 1);
  for (const change of amendment.amendments) {
    assert.equal(previousLabels.get(change.key), change.previousVerdict);
    const anchor = anchors.get(change.key);
    assert(anchor);
    for (const field of [
      "recordId",
      "outputSha256",
      "semanticVerdict",
      "candidateEvidence",
      "factualBasis",
      "rationale",
    ] as const)
      assert.equal(change[field], anchor[field], "Label amendment and anchor disagree: " + field);
  }
  const references = loadReferenceBundle();
  const contracts = loadManifest().cases.map((entry) => caseGradingContract(loadCase(entry.id)));
  const records = saved.rows.map((row) => {
    const key = savedKey(row);
    const item = loadCase(row.testCase.vars.caseId);
    const deterministic = gradeEpisode(row.response.output, item);
    const oldDeterministic = row.gradingResult.componentResults.find(
      (c) => c.assertion.type === "javascript"
    )!;
    const oldSemantic = row.gradingResult.componentResults.find(
      (c) => c.assertion.type === "llm-rubric"
    )!;
    const review = anchors.get(key);
    const tools = JSON.parse(row.response.output).tools as Array<{ success: boolean }>;
    return {
      key,
      recordId: row.id,
      caseId: item.id,
      role: item.record.role,
      provider: row.provider.id,
      outputSha256: sha256(row.response.output),
      rubricSha256: sha256(buildRubric(item, references?.answers.get(item.id)?.answer)),
      original: {
        nativePass: row.success,
        deterministic: oldDeterministic.pass,
        semantic: { pass: oldSemantic.pass, score: oldSemantic.score, reason: oldSemantic.reason },
      },
      deterministic,
      deterministicChanged: deterministic.pass !== oldDeterministic.pass,
      semanticReview: review?.semanticVerdict ?? "not_reviewed",
      // This is a proposed offline adjudication, not a new native/judge result.
      proposedEpisodeVerdict: !deterministic.pass
        ? "fail"
        : (review?.semanticVerdict ?? "not_reviewed"),
      rejectedToolCalls: tools.filter((tool) => !tool.success).length,
      review: review ?? null,
    };
  });
  const reviewCounts = Object.fromEntries(
    ["pass", "fail", "needs_review", "not_reviewed"].map((verdict) => [
      verdict,
      records.filter((row) => row.semanticReview === verdict).length,
    ])
  );
  const plan = {
    mode: "offline replay and proposed adjudication; zero API calls",
    sourceEvalId: saved.evalId,
    rawResult: saved.rawResult,
    gradingVersion,
    labelRevision: amendment.labelRevision,
    rubricStatus: "finalized_offline",
    resolvedAdjudications: adjudications.decisions.length,
    paidStatus: JSON.parse(readFileSync(resolve(directory, "execution-policy.json"), "utf8"))
      .status,
    originalScoresUnchanged: true,
    candidateInputsUnchanged: true,
    independentHumanApproval: false,
    empiricalJudgeCalibration:
      "Pilot completed 26/27 against preserved pre-amendment labels; repeat stability and independent validation pending",
    reviewedSubsetIsRepresentative: false,
    artifactsSha256: Object.fromEntries(
      [
        "dataset.json",
        "grading-policy.ts",
        "assertions.ts",
        "held-judge.ts",
        "execution-policy.ts",
        "offline-review.ts",
        "saved-comparison.ts",
        "saved-output-provider.ts",
        "regrade-config.ts",
        "judge-scope.ts",
        "judge-calibration-config.ts",
        "run-judge-calibration.ts",
        "calibration/anchors.json",
        "calibration/adjudications.json",
        "calibration/label-amendments.json",
        "references/index.json",
      ].map((file) => [file, sha256(readFileSync(resolve(directory, file)))])
    ),
    count: records.length,
    deterministicPassed: records.filter((r) => r.deterministic.pass).length,
    deterministicChanges: records.filter((r) => r.deterministicChanged).length,
    reviewCounts,
    oldFailuresProposedSemanticPass: records.filter(
      (r) => !r.original.semantic.pass && r.semanticReview === "pass"
    ).length,
    oldPassesProposedSemanticFail: records.filter(
      (r) => r.original.semantic.pass && r.semanticReview === "fail"
    ).length,
    records,
  };
  assert.equal(plan.paidStatus, "on_hold", "Offline calibration must preserve the paid hold");
  return { plan, contracts };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { plan, contracts } = buildOfflineReview();
  mkdirSync(resolve(directory, "calibration"), { recursive: true });
  writeFileSync(
    resolve(directory, "calibration/offline-review.json"),
    JSON.stringify(plan, null, 2) + "\n"
  );
  writeFileSync(
    resolve(directory, "calibration/contracts.json"),
    JSON.stringify(contracts, null, 2) + "\n"
  );
  console.log(
    JSON.stringify(
      {
        mode: plan.mode,
        count: plan.count,
        deterministicPassed: plan.deterministicPassed,
        deterministicChanges: plan.deterministicChanges,
        reviewCounts: plan.reviewCounts,
        paidStatus: plan.paidStatus,
      },
      null,
      2
    )
  );
}
