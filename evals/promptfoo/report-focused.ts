import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { directory } from "./dataset.js";
import { sha256 } from "./saved-comparison.js";
import { priceJudgeUsage } from "./report-judge-calibration.js";
import type { ReplayResult } from "./provider.js";

type CandidateEvent = {
  phase: string;
  key: string;
  file?: string;
  error?: string;
  elapsedMs?: number;
  chargedEstimateUsd?: number;
};
type NativeRow = {
  success: boolean;
  testCase: { vars: { savedKey: string; rubric: string } };
  response: { output: string };
  gradingResult?: {
    componentResults: { pass: boolean; reason: string; assertion: { type: string } }[];
  };
};
type JudgeEvent = {
  phase: string;
  key: string;
  semanticVerdict?: string;
  elapsedMs?: number;
  promptFile?: string;
  promptSha256?: string;
  error?: string;
  response?: {
    cached?: boolean;
    raw?: { usage?: Parameters<typeof priceJudgeUsage>[0]; model?: string; service_tier?: string };
  };
};
export const median = (values: number[]) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : null;
export function orderFocused<
  T extends { passed: number; medianCandidateMs: number | null; effort: string; model: string },
>(groups: T[]) {
  return [...groups].sort(
    (a, b) =>
      b.passed - a.passed ||
      (a.medianCandidateMs ?? Infinity) - (b.medianCandidateMs ?? Infinity) ||
      ["low", "medium", "high"].indexOf(a.effort) - ["low", "medium", "high"].indexOf(b.effort) ||
      a.model.localeCompare(b.model)
  );
}
export function reportFocused(dir: string) {
  const json = (file: string) => JSON.parse(readFileSync(resolve(dir, file), "utf8"));
  const manifest = json("manifest.json"),
    plan = json("plan.snapshot.json"),
    timing = json("timing.json"),
    link = json("judge-link.json");
  assert.equal(sha256(readFileSync(resolve(dir, "fixtures.json"))), manifest.fixtureSha256);
  assert.equal(sha256(readFileSync(resolve(dir, "plan.snapshot.json"))), manifest.planSha256);
  const events = readFileSync(resolve(dir, "candidates.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line)) as CandidateEvent[];
  const completed = events.filter((row) => row.phase === "completed");
  assert.equal(events.filter((row) => row.phase === "started").length, plan.candidateEpisodes);
  assert.equal(completed.length, plan.candidateEpisodes);
  assert.equal(new Set(completed.map((row) => row.key)).size, plan.candidateEpisodes);
  const judged = json("judge.promptfoo.json");
  const rows = judged.results.results as NativeRow[];
  const judges = readFileSync(resolve(link.judgeDirectory, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line)) as JudgeEvent[];
  const judgeCompleted = judges.filter((row) => row.phase === "completed");
  assert.equal(judges.filter((row) => row.phase === "started").length, link.expected);
  assert.equal(judgeCompleted.length, link.expected);
  const reusedKeys = new Set<string>(
    existsSync(resolve(dir, "reuse.json"))
      ? json("reuse.json").records.map((row: { key: string }) => row.key)
      : []
  );
  const records = completed.map((event) => {
    const [caseId, profile] = event.key.split("::");
    const [model, effort] = profile.split(":");
    const candidate = event.file ? json(event.file) : undefined;
    const native = rows.find((row) => row.testCase.vars.savedKey === event.key);
    const judge = judgeCompleted.find((row) => row.key === event.key);
    const components = native?.gradingResult?.componentResults ?? [];
    const deterministic = components.find((row) => row.assertion.type === "javascript");
    const semantic = components.find((row) => row.assertion.type === "llm-rubric");
    if (candidate) {
      assert(native && judge, "Candidate answer missing its saved-output judgment");
      assert.equal(sha256(candidate.output), sha256(native.response.output));
      const claim = judges.find((row) => row.phase === "started" && row.key === event.key)!;
      assert.equal(
        sha256(
          readFileSync(resolve(link.judgeDirectory, claim.promptFile!), "utf8").replace(/\n$/, "")
        ),
        claim.promptSha256
      );
      if (judge.response?.raw) {
        assert.equal(judge.response.raw.model, "gpt-6-sol");
        assert.equal(judge.response.raw.service_tier, "default");
      }
    }
    const role = JSON.parse(readFileSync(resolve(dir, "fixtures.json"), "utf8")).find(
      (row: { item: { id: string } }) => row.item.id === caseId
    ).item.record.role as string;
    const usagePending = candidate?.metadata.accountingPending ?? true;
    const output = candidate ? (JSON.parse(candidate.output) as ReplayResult) : undefined;
    return {
      key: event.key,
      reused: reusedKeys.has(event.key),
      caseId,
      role,
      model,
      effort,
      passed: native?.success === true,
      deterministicPassed: deterministic?.pass === true,
      semanticVerdict:
        judge?.semanticVerdict?.toLowerCase() ?? (candidate ? "judge_error" : "candidate_error"),
      reason: semantic?.reason ?? event.error ?? "Missing result",
      deterministicReason: deterministic?.reason,
      candidateElapsedMs: event.elapsedMs!,
      phases: candidate?.metadata.phases,
      candidateTokens: candidate?.tokenUsage,
      candidateAccountingPending: usagePending,
      candidateEstimatedUsd:
        !usagePending && typeof candidate?.cost === "number" ? (candidate.cost as number) : null,
      candidateCostCaveat: candidate?.metadata.pricingCaveat,
      judgeElapsedMs: judge?.elapsedMs,
      judgeEstimatedUsd: judge?.response?.raw?.usage
        ? priceJudgeUsage(judge.response.raw.usage)
        : null,
      outputSha256: candidate ? sha256(candidate.output) : null,
      toolCalls: output?.tools.length,
      failedToolCalls: output?.tools.filter((tool) => !tool.success).length,
    };
  });
  const groups = Object.entries(plan.roles).flatMap(([role, profiles]) =>
    (profiles as { model: string; effort: string }[]).map((profile) => {
      const items = records.filter(
        (row) => row.role === role && row.model === profile.model && row.effort === profile.effort
      );
      assert.equal(items.length, 9);
      const costComplete = items.every((row) => row.candidateEstimatedUsd !== null);
      return {
        role,
        ...profile,
        cases: 9,
        passed: items.filter((row) => row.passed).length,
        deterministicPassed: items.filter((row) => row.deterministicPassed).length,
        semanticPassed: items.filter((row) => row.semanticVerdict === "pass").length,
        abstentions: items.filter((row) => row.semanticVerdict === "needs_review").length,
        judgeErrors: items.filter((row) => row.semanticVerdict === "judge_error").length,
        candidateErrors: items.filter((row) => row.semanticVerdict === "candidate_error").length,
        medianCandidateMs: median(items.map((row) => row.candidateElapsedMs)),
        medianInferenceMs: median(
          items
            .map((row) => row.phases?.inferenceMs)
            .filter((value): value is number => typeof value === "number")
        ),
        costComplete,
        candidateUsagePending: items.filter((row) => row.candidateAccountingPending).length,
        candidateEstimatedUsd: costComplete
          ? items.reduce((sum, row) => sum + row.candidateEstimatedUsd!, 0)
          : null,
        candidateKnownEstimatedUsd: items.reduce(
          (sum, row) => sum + (row.candidateEstimatedUsd ?? 0),
          0
        ),
      };
    })
  );
  const selectionRole = plan.selectionRole ?? "Risk Review";
  const ranked = orderFocused(groups.filter((row) => row.role === selectionRole));
  const best = ranked[0];
  const summary = {
    runId: manifest.runId,
    evalId: judged.evalId,
    gradingVersion: manifest.gradingVersion,
    evidencePolicyVersion: manifest.evidencePolicyVersion,
    candidateAttempts: plan.candidateEpisodes,
    freshCandidateAttempts: plan.candidateEpisodes - reusedKeys.size,
    reusedAttempts: reusedKeys.size,
    judgeAttempts: link.expected,
    passed: records.filter((row) => row.passed).length,
    timing,
    groups,
    selectedRole: selectionRole,
    decision: {
      ...best,
      qualityGateMet: best.passed >= plan.qualityGate,
      provisional: true,
      productionDefaultsChanged: false,
      scope:
        "Best observed within this focused development screen; no further paid batch authorized",
    },
    powerValidation:
      selectionRole === "Risk Review"
        ? groups.find((row) => row.role === "Power & Thermal")
        : undefined,
    retainedProfiles: plan.retainedProfiles,
    cost: {
      freshCandidateKnownEstimatedUsd: records
        .filter((row) => !row.reused)
        .reduce((sum, row) => sum + (row.candidateEstimatedUsd ?? 0), 0),
      reusedCandidateKnownEstimatedUsd: records
        .filter((row) => row.reused)
        .reduce((sum, row) => sum + (row.candidateEstimatedUsd ?? 0), 0),
      candidateKnownEstimatedUsd: records.reduce(
        (sum, row) => sum + (row.candidateEstimatedUsd ?? 0),
        0
      ),
      candidateUsageMissing: records.filter((row) => row.candidateEstimatedUsd === null).length,
      judgeEstimatedUsd: records.reduce((sum, row) => sum + (row.judgeEstimatedUsd ?? 0), 0),
      judgeUsageMissing: records.filter(
        (row) => row.semanticVerdict !== "candidate_error" && row.judgeEstimatedUsd === null
      ).length,
      candidateFailuresNotJudged: records.filter((row) => row.semanticVerdict === "candidate_error")
        .length,
      caveat: plan.costHandling,
    },
    limitations: plan.limitations,
    paidStatus: JSON.parse(readFileSync(resolve(directory, "execution-policy.json"), "utf8"))
      .status,
    sourceHashes: Object.fromEntries(
      [
        "manifest.json",
        "fixtures.json",
        "plan.snapshot.json",
        "authorization.json",
        "candidates.jsonl",
        "power.promptfoo.json",
        ...(existsSync(resolve(dir, "risk.promptfoo.json")) ? ["risk.promptfoo.json"] : []),
        "judge-cases.json",
        "judge.promptfoo.json",
        "judge-link.json",
        "timing.json",
      ].map((file) => [file, sha256(readFileSync(resolve(dir, file)))])
    ),
    records,
  };
  assert.equal(summary.paidStatus, "on_hold");
  writeFileSync(resolve(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(
    resolve(
      directory,
      selectionRole === "Power & Thermal" ? "power-comparison.json" : "focused-comparison.json"
    ),
    JSON.stringify(summary, null, 2) + "\n"
  );
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv[2], "Run directory required");
  const result = reportFocused(resolve(process.argv[2]));
  console.log(
    JSON.stringify(
      result,
      (key, value) => (["records", "sourceHashes"].includes(key) ? undefined : value),
      2
    )
  );
}
