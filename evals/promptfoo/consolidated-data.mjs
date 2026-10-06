import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const directory = dirname(fileURLToPath(import.meta.url));
const read = (path) => JSON.parse(readFileSync(resolve(directory, path), "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
export function loadConsolidatedData() {
  const files = [
    "regrade.json",
    "focused-comparison.json",
    "power-comparison.json",
    "final-model-choices.json",
    "team-validation.json",
    "disputed-regrade.json",
  ];
  const [luna, focused, power, choices, team, repeats] = files.map(read);
  const original = read("comparison.json");
  assert.equal(
    hash(readFileSync(resolve(directory, original.rawResult.path))),
    original.rawResult.sha256
  );
  const originalRows = read(original.rawResult.path).results.results;
  const sources = [
    {
      id: "luna",
      label: "A · Calibrated Luna sweep",
      short: "A",
      report: luna,
      file: files[0],
      candidate: originalRows,
      judgeFile: "promptfoo.json",
      note: "135 original Luna answers, graded with materiality-v3. Before the later Power evidence-interface and judge-scope fixes.",
    },
    {
      id: "focused",
      label: "B · Corrected Power / Risk screen",
      short: "B",
      report: focused,
      file: files[1],
      candidate: ["power", "risk"].flatMap(
        (role) => read(`results/${focused.runId}/${role}.promptfoo.json`).results.results
      ),
      judgeFile: "judge.promptfoo.json",
      note: "54 attempts under corrected evidence scope; 41 fresh candidates and 13 reused attempts including one timeout. Nine Power/Luna-medium cases are a separate version of the earlier comparison.",
    },
    {
      id: "power",
      label: "C · Power Sol / Astra comparison",
      short: "C",
      report: power,
      file: files[2],
      candidate: read(`results/${power.runId}/power.promptfoo.json`).results.results,
      judgeFile: "judge.promptfoo.json",
      note: "18 fresh attempts. Same nine frozen Power fixtures as phase B; other four role choices held fixed.",
    },
  ];
  const records = [],
    groups = [];
  for (const source of sources) {
    const report = source.report;
    const judgePath = `results/${report.runId}/${source.judgeFile}`;
    assert.equal(
      hash(readFileSync(resolve(directory, judgePath))),
      report.sourceHashes[source.judgeFile]
    );
    const judgments = new Map(
      read(judgePath).results.results.map((row) => [row.testCase.vars.savedKey, row])
    );
    const candidates = new Map(
      source.candidate.map((row) => [row.testCase.vars.caseId + "::" + row.provider.id, row])
    );
    const fixtures = source.id === "luna" ? [] : read(`results/${report.runId}/fixtures.json`);
    for (const row of report.records) {
      const candidate = candidates.get(row.key);
      assert(candidate, `Missing native candidate ${row.key}`);
      const judgment = judgments.get(row.key);
      if (row.outputSha256) {
        assert.equal(
          hash(candidate.response.output),
          row.outputSha256,
          `Changed answer ${row.key}`
        );
        assert(judgment, `Missing native judge ${row.key}`);
        assert.equal(candidate.response.output, judgment.response.output);
        assert.equal(judgment.success, row.passed);
      } else
        assert(!row.passed && !candidate.response?.output, "No-answer failures must be retained");
      let envelope;
      try {
        envelope = JSON.parse(candidate.response?.output);
      } catch {
        envelope = null;
      }
      const caseId = row.caseId ?? row.originalCaseId;
      const fixture = fixtures.find((item) => item.item.id === caseId);
      const components =
        judgment?.gradingResult?.componentResults ??
        candidate.gradingResult?.componentResults ??
        [];
      records.push({
        id: source.id + "::" + row.key,
        key: row.key,
        phase: source.id,
        caseId,
        role: row.role,
        model: row.model ?? "gpt-6-luna",
        effort: row.effort,
        passed: row.passed,
        deterministicPassed: row.deterministicPassed,
        semanticVerdict: row.semanticVerdict,
        reason: row.reason,
        deterministicReason:
          row.deterministicReason ??
          components.find((c) => c.assertion?.type === "javascript")?.reason ??
          "See saved assertions",
        latencyMs: row.candidateElapsedMs ?? row.originalLatencyMs,
        candidateCost: row.candidateEstimatedUsd ?? row.originalCostUsd ?? null,
        accountingPending: row.candidateAccountingPending ?? row.originalAccountingPending,
        outputSha256: row.outputSha256,
        answer: envelope?.answer ?? null,
        tools: envelope?.tools ?? [],
        input: fixture?.item?.replay?.input ?? fixture?.item?.record?.input ?? null,
        rubric: judgment?.testCase?.vars?.rubric ?? candidate.testCase?.vars?.rubric ?? null,
        reused: row.reused ?? false,
        nativeEvalId: candidate
          ? source.id === "luna"
            ? original.evalId
            : read(
                `results/${report.runId}/${row.role === "Risk Review" ? "risk" : "power"}.promptfoo.json`
              ).evalId
          : null,
        judgeEvalId: report.evalId,
      });
    }
    for (const group of report.groups) {
      const model = group.model ?? "gpt-6-luna";
      const rows = records.filter(
        (r) =>
          r.phase === source.id &&
          r.role === group.role &&
          r.model === model &&
          r.effort === group.effort
      );
      assert.equal(rows.length, group.cases);
      assert.equal(rows.filter((r) => r.passed).length, group.passed);
      assert.equal(rows.filter((r) => r.deterministicPassed).length, group.deterministicPassed);
      const pending = rows.filter((r) => r.accountingPending).length;
      assert.equal(pending, group.candidateUsagePending);
      groups.push({
        id: `${source.id}::${group.role}::${model}:${group.effort}`,
        phase: source.id,
        role: group.role,
        model,
        effort: group.effort,
        cases: group.cases,
        passed: group.passed,
        deterministicPassed: group.deterministicPassed,
        semanticPassed: group.semanticPassed,
        medianMs: group.medianCandidateMs ?? group.originalMedianLatencyMs,
        pending,
        costComplete: pending === 0,
        knownCost: rows.reduce((sum, r) => sum + (r.candidateCost ?? 0), 0),
        selected: choices.profiles.some(
          (p) =>
            p.role === group.role &&
            p.model === model &&
            p.reasoningEffort === group.effort &&
            (p.role === "Power & Thermal"
              ? source.id === "power"
              : p.role === "Risk Review"
                ? source.id === "focused"
                : source.id === "luna")
        ),
      });
    }
  }
  assert.equal(records.length, 207);
  assert.equal(new Set(records.map((r) => r.id)).size, 207);
  assert.equal(new Set(records.map((r) => r.key)).size, 198);
  assert.equal(new Set(records.map((r) => r.caseId)).size, 45);
  for (const p of choices.profiles)
    assert(groups.some((g) => g.selected && g.role === p.role && g.passed === p.passes));
  const phases = sources.map((s) => ({
    id: s.id,
    label: s.label,
    short: s.short,
    note: s.note,
    runId: s.report.runId,
    evalId: s.report.evalId,
    source: s.file,
    sha256: hash(readFileSync(resolve(directory, s.file))),
    policy: s.report.gradingVersion,
    evidencePolicy: s.report.evidencePolicyVersion ?? "original scope",
    observations: s.report.records.length,
  }));
  return {
    title: "Mars Mission Control · Consolidated evaluation",
    records,
    groups,
    phases,
    choices: choices.profiles,
    columns: [
      "gpt-6-luna:low",
      "gpt-6-luna:medium",
      "gpt-6-luna:high",
      "gpt-6-sol:low",
      "gpt-6-sol:medium",
      "gpt-6-sol:high",
      "gpt-6-astra:medium",
      "gpt-6-astra:high",
    ],
    roles: [
      "Mission Director",
      "Power & Thermal",
      "Life Support",
      "Weather & Navigation",
      "Risk Review",
    ],
    sourceHashes: Object.fromEntries(
      files.map((f) => [f, hash(readFileSync(resolve(directory, f)))])
    ),
    apiCalls: 0,
    history: {
      originalPassed: original.groups.reduce((n, g) => n + g.passed, 0),
      calibratedPassed: luna.passed,
      repeatedJudgments: repeats.records.length,
      repeatedAgreements: repeats.agreements,
      team: {
        evalId: team.evalId,
        reports: team.reports,
        passed: team.passed,
        feasibleResolved: team.feasibleResolved,
        feasibleMissions: team.feasibleMissions,
        infeasibleAcceptedMitigations: team.infeasibleAcceptedMitigations,
        profiles: team.profiles,
      },
    },
  };
}
