import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { directory, loadCase } from "./dataset.js";
import { loadSavedComparison, savedKey, sha256 } from "./saved-comparison.js";
import { priceJudgeUsage, calibrationRates } from "./report-judge-calibration.js";

export type SelectionGroup = {
  role: string;
  effort: string;
  passed: number;
  cases: number;
  originalMedianLatencyMs: number;
};
export function selectProfiles<T extends SelectionGroup>(groups: T[]) {
  const effortRank = ["low", "medium", "high"];
  return [...new Set(groups.map((group) => group.role))].map((role) => {
    const ordered = groups
      .filter((group) => group.role === role)
      .sort(
        (a, b) =>
          b.passed - a.passed ||
          a.originalMedianLatencyMs - b.originalMedianLatencyMs ||
          effortRank.indexOf(a.effort) - effortRank.indexOf(b.effort)
      );
    assert.equal(ordered.length, 3);
    const best = ordered[0];
    return {
      role,
      model: "gpt-6-luna",
      reasoningEffort: best.effort,
      passes: best.passed,
      cases: best.cases,
      exploratoryQualityGateMet: best.passed >= 8,
      originalMedianLatencyMs: best.originalMedianLatencyMs,
      scope:
        "Best observed Luna setting under predeclared ordering; provisional pending validation",
      alternatives: ordered.slice(1),
    };
  });
}

export function reportRegrade(runDirectory: string) {
  const read = (file: string) => JSON.parse(readFileSync(resolve(runDirectory, file), "utf8"));
  const saved = loadSavedComparison();
  const original = JSON.parse(readFileSync(resolve(directory, saved.rawResult.path), "utf8"))
    .results.results;
  const manifest = read("manifest.json");
  const timing = read("timing.json");
  const authorization = read("authorization.json");
  const frozenAnchors = read("anchors.snapshot.json");
  assert.equal(
    sha256(readFileSync(resolve(runDirectory, "anchors.snapshot.json"))),
    manifest.anchorsSha256
  );
  assert.equal(manifest.sourceEvalId, saved.evalId);
  const native = read("promptfoo.json");
  const events = readFileSync(resolve(runDirectory, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const started = events.filter((event) => event.phase === "started");
  const completed = events.filter((event) => event.phase === "completed");
  for (const rows of [started, completed, native.results.results])
    assert.equal(rows.length, 135, "Incomplete full regrade");
  assert.equal(new Set(started.map((event) => event.key)).size, 135);
  assert.equal(new Set(completed.map((event) => event.key)).size, 135);
  const records = saved.rows.map((row) => {
    const key = savedKey(row);
    const result = native.results.results.find(
      (entry: { testCase: { vars: { savedKey: string } } }) => entry.testCase.vars.savedKey === key
    );
    assert(result);
    assert.equal(result.testCase.metadata.originalRecordId, row.id);
    assert.equal(sha256(result.response.output), sha256(row.response.output));
    const authorized = authorization.judgeScope.records.find(
      (entry: { key: string }) => entry.key === key
    );
    assert.equal(authorized.outputSha256, sha256(row.response.output));
    assert.equal(authorized.rubricSha256, sha256(result.testCase.vars.rubric));
    const event = completed.find((entry) => entry.key === key);
    const claim = started.find((entry) => entry.key === key);
    assert.equal(
      sha256(readFileSync(resolve(runDirectory, claim.promptFile), "utf8").replace(/\n$/, "")),
      claim.promptSha256
    );
    const semantic = result.gradingResult.componentResults.find(
      (entry: { assertion: { type: string } }) => entry.assertion.type === "llm-rubric"
    );
    const deterministic = result.gradingResult.componentResults.find(
      (entry: { assertion: { type: string } }) => entry.assertion.type === "javascript"
    );
    const previous = original.find((entry: { id: string }) => entry.id === row.id);
    const verdict = event.semanticVerdict?.toLowerCase() ?? "judge_error";
    const cached = event.response?.cached === true;
    const usage = event.response?.raw?.usage;
    const cost = cached ? 0 : usage ? priceJudgeUsage(usage) : null;
    if (event.response?.raw) {
      assert.equal(event.response.raw.model, "gpt-6-sol");
      assert.equal(event.response.raw.service_tier, "default");
    }
    const label = frozenAnchors.anchors.find((entry: { key: string }) => entry.key === key);
    return {
      key,
      originalRecordId: row.id,
      originalCaseId: row.testCase.vars.caseId,
      originalProvider: row.provider.id,
      role: loadCase(row.testCase.vars.caseId).record.role,
      effort: row.provider.id.split(":")[1],
      outputSha256: sha256(row.response.output),
      originalPassed: row.success,
      passed: result.success,
      deterministicPassed: deterministic.pass,
      semanticVerdict: verdict,
      reason: semantic.reason,
      reviewedLabel: label?.semanticVerdict ?? null,
      labelAgreement: label ? label.semanticVerdict === verdict : null,
      originalLatencyMs: previous.latencyMs,
      originalAccountingPending: previous.response.metadata?.accountingPending ?? true,
      originalCostUsd: previous.response.metadata?.accountingPending
        ? null
        : (previous.response.cost ?? null),
      judgeLatencyMs: event.elapsedMs,
      judgeCached: cached,
      judgeResponseId: event.response?.raw?.id,
      judgeRawUsage: usage,
      incrementalJudgeEstimatedUsd: cost,
    };
  });
  assert.equal(new Set(records.map((row) => row.key)).size, 135);
  const median = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const groups = [...new Set(records.map((row) => row.role))].flatMap((role) =>
    ["low", "medium", "high"].map((effort) => {
      const rows = records.filter((row) => row.role === role && row.effort === effort);
      assert.equal(rows.length, 9);
      return {
        role,
        effort,
        cases: rows.length,
        passed: rows.filter((row) => row.passed).length,
        deterministicPassed: rows.filter((row) => row.deterministicPassed).length,
        semanticPassed: rows.filter((row) => row.semanticVerdict === "pass").length,
        abstentions: rows.filter((row) => row.semanticVerdict === "needs_review").length,
        judgeErrors: rows.filter((row) => row.semanticVerdict === "judge_error").length,
        originalMedianLatencyMs: median(rows.map((row) => row.originalLatencyMs)),
        candidateUsagePending: rows.filter((row) => row.originalAccountingPending).length,
        candidateCostComplete: rows.every((row) => row.originalCostUsd !== null),
        candidateEstimatedCostUsd: rows.every((row) => row.originalCostUsd !== null)
          ? rows.reduce((sum, row) => sum + (row.originalCostUsd ?? 0), 0)
          : null,
      };
    })
  );
  const selection = selectProfiles(groups);
  const fresh = records.filter((row) => !row.judgeCached);
  const summary = {
    evalId: native.evalId,
    sourceEvalId: saved.evalId,
    gradingVersion: manifest.gradingVersion,
    labelRevision: manifest.labelRevision,
    runId: manifest.runId,
    candidateCalls: 0,
    outputs: records.length,
    freshJudgeCalls: fresh.length,
    cachedJudgeResponses: records.length - fresh.length,
    passed: records.filter((row) => row.passed).length,
    failed: records.filter((row) => !row.passed).length,
    deterministicPassed: records.filter((row) => row.deterministicPassed).length,
    semanticPassed: records.filter((row) => row.semanticVerdict === "pass").length,
    abstentions: records.filter((row) => row.semanticVerdict === "needs_review").length,
    judgeErrors: records.filter((row) => row.semanticVerdict === "judge_error").length,
    reviewedAnchorAgreement: {
      agreed: records.filter((row) => row.labelAgreement).length,
      total: frozenAnchors.anchors.length,
    },
    timing,
    freshJudgeMedianLatencyMs: median(fresh.map((row) => row.judgeLatencyMs)),
    incrementalJudgeEstimatedUsd: fresh.reduce(
      (sum, row) => sum + (row.incrementalJudgeEstimatedUsd ?? 0),
      0
    ),
    judgeUsageMissing: fresh.filter((row) => row.incrementalJudgeEstimatedUsd === null).length,
    rates: calibrationRates,
    originalCandidateUsagePending: records.filter((row) => row.originalAccountingPending).length,
    originalScoresPreserved: true,
    selectionPolicySha256: sha256(readFileSync(resolve(directory, "selection-policy.json"))),
    groups,
    selection,
    records,
    sourceHashes: Object.fromEntries(
      [
        "manifest.json",
        "authorization.json",
        "calls.jsonl",
        "promptfoo.json",
        "timing.json",
        "anchors.snapshot.json",
        "offline-review.snapshot.json",
        "label-amendments.snapshot.json",
      ].map((file) => [file, sha256(readFileSync(resolve(runDirectory, file)))])
    ),
    limitations: [
      "One candidate attempt per case, nine correlated cases per role",
      "Cached judgments are reused assessments, not independent judge stability evidence",
      "Partial original cost data cannot establish a cost winner",
      "Provisional selection within Luna only; production defaults unchanged",
    ],
  };
  writeFileSync(resolve(directory, "regrade.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(
    resolve(directory, "selected-profiles.json"),
    JSON.stringify(
      {
        sourceEvalId: native.evalId,
        gradingVersion: manifest.gradingVersion,
        selectionPolicySha256: summary.selectionPolicySha256,
        provisional: true,
        productionDefaultsChanged: false,
        profiles: Object.fromEntries(
          selection.map((row) => [
            row.role,
            { model: row.model, reasoningEffort: row.reasoningEffort },
          ])
        ),
        evidence: selection,
      },
      null,
      2
    ) + "\n"
  );
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv[2], "Provide full regrade directory");
  const report = reportRegrade(resolve(process.argv[2]));
  console.log(JSON.stringify(report, (key, value) => (key === "records" ? undefined : value), 2));
}
