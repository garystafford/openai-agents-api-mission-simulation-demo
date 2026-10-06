import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { directory } from "./dataset.js";
import { sha256 } from "./saved-comparison.js";
import { priceJudgeUsage } from "./report-judge-calibration.js";

export function reportValidation(judgeDirectory: string) {
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const judgeManifest = read(resolve(judgeDirectory, "manifest.json"));
  const teamDirectory = judgeManifest.validationDirectory;
  assert(teamDirectory, "Not a validation judge run");
  const team = read(resolve(teamDirectory, "manifest.json"));
  const casesBytes = readFileSync(resolve(teamDirectory, "cases.json"));
  assert.equal(sha256(casesBytes), judgeManifest.validationCasesSha256);
  const prepared = JSON.parse(casesBytes.toString());
  const cases = prepared.cases;
  assert.equal(
    sha256(readFileSync(resolve(teamDirectory, "manifest.json"))),
    JSON.parse(casesBytes.toString()).sourceManifestSha256
  );
  const native = read(resolve(judgeDirectory, "promptfoo.json"));
  const events = readFileSync(resolve(judgeDirectory, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const completed = events.filter((row) => row.phase === "completed");
  assert.equal(completed.length, cases.length);
  assert.equal(new Set(completed.map((row) => row.key)).size, cases.length);
  assert.equal(native.results.results.length, cases.length);
  assert.equal(sha256(readFileSync(resolve(teamDirectory, "inputs.json"))), team.inputSha256);
  const authorization = read(resolve(judgeDirectory, "authorization.json"));
  const records = cases.map(
    (item: {
      key: string;
      output: string;
      outputSha256: string;
      rubric: string;
      role: string;
      missionId: string;
      scenario: string;
      source: string;
      error?: string;
      deterministic: { pass: boolean; reason: string };
    }) => {
      const result = native.results.results.find(
        (row: { testCase: { vars: { savedKey: string } } }) =>
          row.testCase.vars.savedKey === item.key
      );
      assert.equal(sha256(result.response.output), item.outputSha256);
      const event = completed.find((row) => row.key === item.key);
      const bound = authorization.judgeScope.records.find(
        (row: { key: string }) => row.key === item.key
      );
      assert.equal(bound.outputSha256, item.outputSha256);
      assert.equal(bound.rubricSha256, sha256(item.rubric));
      const semantic = result.gradingResult.componentResults.find(
        (row: { assertion: { type: string } }) => row.assertion.type === "llm-rubric"
      );
      const cached = event.response?.cached === true;
      const usage = event.response?.raw?.usage;
      if (event.response?.raw) {
        assert.equal(event.response.raw.model, "gpt-6-sol");
        assert.equal(event.response.raw.service_tier, "default");
      }
      return {
        key: item.key,
        role: item.role,
        scenario: item.scenario,
        missionId: item.missionId,
        source: item.source,
        executionError: item.error ?? null,
        passed: result.success,
        deterministic: item.deterministic,
        semanticVerdict: event.semanticVerdict?.toLowerCase() ?? "judge_error",
        reason: semantic.reason,
        judgeCached: cached,
        judgeRawUsage: usage,
        judgeResponseId: event.response?.raw?.id,
        incrementalJudgeEstimatedUsd: cached ? 0 : usage ? priceJudgeUsage(usage) : null,
      };
    }
  );
  const groups = [...new Set(records.map((r: { role: string }) => r.role))].map((role) => {
    const rows = records.filter((r: { role: string }) => r.role === role);
    return {
      role,
      reports: rows.length,
      primaryReports: rows.filter((r: { source: string }) => r.source === "director_selected")
        .length,
      supplementReports: rows.filter((r: { source: string }) => r.source === "coverage_supplement")
        .length,
      passed: rows.filter((r: { passed: boolean }) => r.passed).length,
      deterministicFailures: rows.filter(
        (r: { deterministic: { pass: boolean } }) => !r.deterministic.pass
      ).length,
      semanticFailures: rows.filter(
        (r: { semanticVerdict: string }) => r.semanticVerdict === "fail"
      ).length,
      unresolvedOrErrors: rows.filter(
        (r: { semanticVerdict: string }) => !["pass", "fail"].includes(r.semanticVerdict)
      ).length,
    };
  });
  const missionGate =
    team.rows.length === 10 &&
    team.rows.every(
      (row: {
        feasible: boolean;
        status: string;
        missionId: string;
        sessionsDeleted: boolean;
        plans: { exactProposalApproved: boolean }[];
        outcome?: { hardFailure?: string };
      }) =>
        row.sessionsDeleted &&
        row.plans.length > 0 &&
        row.plans.every((plan) => plan.exactProposalApproved) &&
        (!row.feasible || row.status === "resolved") &&
        (row.feasible ||
          records.some(
            (record: { missionId: string; role: string; deterministic: { pass: boolean } }) =>
              record.missionId === row.missionId &&
              record.role === "Mission Director" &&
              record.deterministic.pass
          )) &&
        !row.outcome?.hardFailure &&
        row.status !== "error"
    );
  const selected = read(resolve(teamDirectory, "selected-profiles.snapshot.json"));
  const summary = {
    runId: team.runId,
    evalId: native.evalId,
    profiles: team.profiles,
    missions: team.rows.length,
    resolved: team.rows.filter((row: { status: string }) => row.status === "resolved").length,
    feasibleMissions: team.rows.filter((row: { feasible: boolean }) => row.feasible).length,
    infeasibleMissions: team.rows.filter((row: { feasible: boolean }) => !row.feasible).length,
    infeasibleAcceptedMitigations: team.rows.filter(
      (row: { feasible: boolean; missionId: string }) => {
        const directors = records.filter(
          (record: { role: string; missionId: string }) =>
            record.role === "Mission Director" && record.missionId === row.missionId
        );
        return (
          !row.feasible &&
          directors.length > 0 &&
          directors.every(
            (record: { deterministic: { pass: boolean } }) => record.deterministic.pass
          )
        );
      }
    ).length,
    feasibleResolved: team.rows.filter(
      (row: { feasible: boolean; status: string }) => row.feasible && row.status === "resolved"
    ).length,
    sessionsCleaned: team.rows.filter((row: { sessionsDeleted: boolean }) => row.sessionsDeleted)
      .length,
    missionGateMet: missionGate,
    exploratoryRoleGatesMet: selected.evidence.every(
      (row: { exploratoryQualityGateMet: boolean }) => row.exploratoryQualityGateMet
    ),
    reports: records.length,
    passed: records.filter((r: { passed: boolean }) => r.passed).length,
    allFreshEpisodeChecksPassed:
      records.every((r: { passed: boolean }) => r.passed) &&
      prepared.executionFailures.length === 0,
    allFreshSemanticJudgmentsPassed:
      records.every((r: { semanticVerdict: string }) => r.semanticVerdict === "pass") &&
      prepared.executionFailures.length === 0,
    freshSemanticPasses: records.filter(
      (r: { semanticVerdict: string }) => r.semanticVerdict === "pass"
    ).length,
    semanticReviewComplete: records.every((r: { semanticVerdict: string }) =>
      ["pass", "fail"].includes(r.semanticVerdict)
    ),
    collectionComplete: prepared.collectionComplete,
    executionFailures: prepared.executionFailures,
    groups,
    records,
    missionRows: team.rows,
    teamTiming: read(resolve(teamDirectory, "timing.json")),
    judgeTiming: read(resolve(judgeDirectory, "timing.json")),
    freshJudgeCalls: records.filter((r: { judgeCached: boolean }) => !r.judgeCached).length,
    incrementalJudgeEstimatedUsd: records.reduce(
      (sum: number, row: { incrementalJudgeEstimatedUsd: number | null }) =>
        sum + (row.incrementalJudgeEstimatedUsd ?? 0),
      0
    ),
    judgeUsageMissing: records.filter(
      (r: { incrementalJudgeEstimatedUsd: number | null }) =>
        r.incrementalJudgeEstimatedUsd === null
    ).length,
    candidateUsagePendingMissions: team.rows.filter(
      (row: { usage?: { accountingPending: boolean } }) => !row.usage || row.usage.accountingPending
    ).length,
    candidateKnownPartialEstimatedUsd: team.rows.reduce(
      (sum: number, row: { usage?: { knownEstimatedCostUsd: number } }) =>
        sum + (row.usage?.knownEstimatedCostUsd ?? 0),
      0
    ),
    candidateReservedUsd: 20,
    candidateCostCaveat:
      "Runtime nominal estimate covers tracked input/cache-read/output categories, but does not retain cache-write counts. Not a billing reconciliation.",
    productionDefaultsChanged: false,
    recommendation:
      "Provisional Luna-only evidence; deployment requires all quality gates and independent review",
    limitations: [
      "Five new states with two repetitions each, within existing scenario families",
      "Development calibration agreement is not held-out human-label accuracy",
      "Runtime accounting can remain pending; no complete cost optimum claimed",
      "No profile tuning on validation outputs",
      "Fresh questions and adaptive interactions differ from the fixed replay; score differences are not a controlled improvement estimate",
      "Mission elapsed time includes post-outcome coverage supplements and cleanup; approvalReadyMs isolates the initial Director investigation",
    ],
    artifactHashes: {
      teamManifest: sha256(readFileSync(resolve(teamDirectory, "manifest.json"))),
      cases: sha256(casesBytes),
      judgeManifest: sha256(readFileSync(resolve(judgeDirectory, "manifest.json"))),
      native: sha256(readFileSync(resolve(judgeDirectory, "promptfoo.json"))),
      journal: sha256(readFileSync(resolve(judgeDirectory, "calls.jsonl"))),
    },
  };
  writeFileSync(
    resolve(directory, "team-validation.json"),
    JSON.stringify(summary, null, 2) + "\n"
  );
  console.log(JSON.stringify({ ...summary, records: undefined, missionRows: undefined }, null, 2));
  return summary;
}

if (process.argv[1]?.endsWith("report-validation.ts")) {
  assert(process.argv[2], "Judge run directory required");
  reportValidation(resolve(process.argv[2]));
}
