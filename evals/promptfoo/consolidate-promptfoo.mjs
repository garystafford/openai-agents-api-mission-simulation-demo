// Importable native Promptfoo matrix. Reads saved artifacts only; never evaluates.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { directory, loadConsolidatedData } from "./consolidated-data.mjs";
const read = (p) => JSON.parse(readFileSync(resolve(directory, p), "utf8"));
const data = loadConsolidatedData();
const original = read("comparison.json");
const saved = new Map();
for (const phase of data.phases) {
  const files =
    phase.id === "luna"
      ? [original.rawResult.path]
      : (phase.id === "focused" ? ["power", "risk"] : ["power"]).map(
          (r) => `results/${phase.runId}/${r}.promptfoo.json`
        );
  const judgments = new Map(
    read(
      `results/${phase.runId}/${phase.id === "luna" ? "promptfoo.json" : "judge.promptfoo.json"}`
    ).results.results.map((r) => [r.testCase.vars.savedKey, r])
  );
  for (const file of files)
    for (const row of read(file).results.results) {
      const key = row.testCase.vars.caseId + "::" + row.provider.id;
      saved.set(phase.id + "::" + key, { candidate: row, judge: judgments.get(key) });
    }
}
const testKeys = [...new Set(data.records.map((r) => r.phase + "::" + r.caseId))];
assert.equal(testKeys.length, 72);
const tests = testKeys.map((key) => {
  const r = data.records.find((r) => r.phase + "::" + r.caseId === key);
  return {
    description: `${data.phases.find((p) => p.id === r.phase).label} | ${r.role} | ${r.caseId.split("--").slice(1).join(" / ")}`,
    vars: {
      agent: r.role,
      phase: data.phases.find((p) => p.id === r.phase).label,
      caseId: r.caseId,
    },
    metadata: { phase: r.phase, role: r.role },
  };
});
const results = data.records.map((r) => {
  const { candidate, judge } = saved.get(r.id);
  const out = structuredClone(candidate);
  out.id = randomUUID();
  out.promptIdx = data.columns.indexOf(r.model + ":" + r.effort);
  out.testIdx = testKeys.indexOf(r.phase + "::" + r.caseId);
  out.testCase = structuredClone(tests[out.testIdx]);
  out.vars = out.testCase.vars;
  out.testCase.assert = structuredClone((judge ?? candidate).testCase.assert);
  if (judge) {
    for (const key of [
      "gradingResult",
      "success",
      "score",
      "failureReason",
      "error",
      "namedScores",
    ]) {
      delete out[key];
      if (key in judge) out[key] = structuredClone(judge[key]);
    }
    out.tokenUsage.assertions = structuredClone(judge.gradingResult.tokensUsed);
  }
  // Missing candidate cost is omitted rather than converted into a zero charge.
  if (r.accountingPending) {
    delete out.cost;
    if (out.response) delete out.response.cost;
  }
  out.latencyMs = r.latencyMs;
  out.metadata = {
    ...out.metadata,
    phase: r.phase,
    role: r.role,
    sourceAnswerSha256: r.outputSha256,
    candidateCostUnknown: r.accountingPending,
    sourceCandidateEvalId: r.nativeEvalId,
    sourceJudgeEvalId: r.judgeEvalId,
  };
  out.provider = { id: r.model + ":" + r.effort, label: r.model + ":" + r.effort };
  return out;
});
function sumUsage(usages) {
  const out = {};
  for (const usage of usages)
    for (const [k, v] of Object.entries(usage ?? {})) {
      if (typeof v === "number") out[k] = (out[k] ?? 0) + v;
      else if (v && typeof v === "object") out[k] = sumUsage([out[k], v]);
    }
  return out;
}
const prompts = data.columns.map((provider, index) => {
  const rows = results.filter((r) => r.promptIdx === index),
    components = rows.flatMap((r) => r.gradingResult?.componentResults ?? []);
  const raw = "{{caseId}}";
  const id = createHash("sha256").update(raw).digest("hex");
  rows.forEach((r) => {
    r.promptId = id;
    r.prompt = { ...r.prompt, label: "Frozen case replay", raw: r.testCase.vars.caseId };
  });
  return {
    id,
    raw,
    label: "Frozen case replay",
    provider,
    metrics: {
      score: rows.reduce((n, r) => n + r.score, 0),
      testPassCount: rows.filter((r) => r.success).length,
      testFailCount: rows.filter((r) => !r.success && r.failureReason !== 2).length,
      testErrorCount: rows.filter((r) => r.failureReason === 2).length,
      assertPassCount: components.filter((c) => c.pass).length,
      assertFailCount: components.filter((c) => !c.pass).length,
      totalLatencyMs: rows.reduce((n, r) => n + r.latencyMs, 0),
      tokenUsage: sumUsage(rows.map((r) => r.tokenUsage)),
      namedScores: {},
      namedScoresCount: {},
      namedScoreWeights: {},
      ...(rows.some((r) => r.metadata.candidateCostUnknown)
        ? {}
        : { cost: rows.reduce((n, r) => n + (r.cost ?? 0), 0) }),
    },
  };
});
const metadata = {
  derivedOffline: true,
  sourceHashes: data.sourceHashes,
  phases: data.phases,
  paidCalls: 0,
  uniqueCaseConfigurationPairs: 198,
  attempts: 207,
  notes:
    "Saved candidate outputs and final raw grades. A/B/C are different evaluation phases. Filter agent and phase for interpretation; overall provider rates use different case sets and are not a fair global ranking. Empty cells are NOT TESTED. Unknown cost omitted; displayed known costs exclude missing usage and judge charges. No new experiment or regrading.",
};
const now = new Date().toISOString();
const output = {
  results: {
    version: 3,
    timestamp: now,
    prompts,
    results,
    stats: {
      successes: results.filter((r) => r.success).length,
      failures: results.filter((r) => !r.success && r.failureReason !== 2).length,
      errors: results.filter((r) => r.failureReason === 2).length,
      tokenUsage: sumUsage(results.map((r) => r.tokenUsage)),
    },
  },
  config: {
    description:
      "COMPLETE GPT-6 EVAL — all 5 agents · saved final grades · phases A/B/C (filter agent/phase; untested cells blank)",
    prompts: ["{{caseId}}"],
    providers: data.columns.map((id) => ({ id, label: id })),
    tests,
    metadata,
    defaultTest: {},
  },
  metadata,
  vars: ["agent", "phase", "caseId"],
};
assert.equal(results.length, 207);
assert.equal(new Set(results.map((r) => r.testIdx + ":" + r.promptIdx)).size, 207);
assert.equal(prompts.length, 8);
const destination = resolve(directory, "results/consolidated-view");
mkdirSync(destination, { recursive: true });
writeFileSync(
  resolve(destination, "complete.promptfoo.json"),
  JSON.stringify(output, null, 2) + "\n"
);
writeFileSync(resolve(destination, "provenance.json"), JSON.stringify(metadata, null, 2) + "\n");
console.log(
  JSON.stringify({
    file: resolve(destination, "complete.promptfoo.json"),
    rows: tests.length,
    columns: prompts.length,
    savedAttempts: results.length,
    apiCalls: 0,
  })
);
