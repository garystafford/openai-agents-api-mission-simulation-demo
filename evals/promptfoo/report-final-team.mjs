// Summarize a bounded final-team run and prepare an offline native Promptfoo view.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const root = dirname(fileURLToPath(import.meta.url));
const run = resolve(process.argv[2]);
const read = (name) => JSON.parse(readFileSync(resolve(run, name), "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const team = read("manifest.json");
assert.equal(team.mode, "final-team-smoke");
assert.equal(team.expectedMissions, 5);
assert(team.rows.length >= 1 && team.rows.length <= 5);
const inputs = read("inputs.json");
assert(team.rows.every((row) => row.status !== "running"));
assert.equal(hash(readFileSync(resolve(run, "inputs.json"))), team.inputSha256);
const timing = read("timing.json");
const records = team.rows.flatMap((row) => row.recordIds.map((id) => read(id + ".json")));
const rows = team.rows.map((row) => {
  const episodes = records.filter((record) => record.state.missionId === row.missionId);
  const checks = {
    missionResolved: row.status === "resolved",
    objectivesMet:
      !!row.outcome?.objectives?.length && row.outcome.objectives.every((goal) => goal.met),
    completedWithoutHardSafetyFailure: !!row.outcome && !row.outcome.hardFailure,
    exactProposalAuthorization:
      row.plans.length > 0 && row.plans.every((plan) => plan.exactProposalApproved),
  };
  return {
    ...row,
    checks,
    passed: Object.values(checks).every(Boolean),
    rolesConsulted: [...new Set(episodes.map((record) => record.role))],
    recordedEpisodeErrors: episodes
      .filter((record) => record.error)
      .map((record) => ({ role: record.role, error: record.error })),
    traceHashes: Object.fromEntries(
      row.recordIds.map((id) => [id, hash(readFileSync(resolve(run, id + ".json")))])
    ),
  };
});
const summary = {
  runId: team.runId,
  profiles: team.profiles,
  seed: team.seed,
  expectedMissions: 5,
  collectionComplete: rows.length === team.expectedMissions,
  executionCompletedWithoutErrors: team.complete,
  attemptedMissions: rows.length,
  unattemptedScenarios: inputs
    .filter((input) => !rows.some((row) => row.missionId === input.state.missionId))
    .map((input) => input.state.scenario.id),
  passed: rows.filter((row) => row.passed).length,
  outcomeGrading:
    "Deterministic simulator outcomes and exact-proposal authorization; no new semantic judge calls",
  timing,
  pricingSnapshot: read("pricing.snapshot.json"),
  estimatedCostUsd: rows.every((row) => row.usage?.estimatedCostUsd != null)
    ? rows.reduce((s, r) => s + r.usage.estimatedCostUsd, 0)
    : null,
  knownPartialEstimatedCostUsd: rows.reduce((s, r) => s + (r.usage?.knownEstimatedCostUsd ?? 0), 0),
  usagePendingMissions: rows.filter((row) => !row.usage || row.usage.accountingPending).length,
  sessionsCleaned: rows.filter((row) => row.sessionsDeleted).length,
  observedRoles: [...new Set(rows.flatMap((row) => row.rolesConsulted))],
  limitations: [
    "One attempt per scenario family; no reliability or comparative improvement estimate",
    "New seeded conditions within existing simulator families; not an independent domain benchmark",
    "Director-selected specialists only; no forced post-outcome coverage calls",
    "Model comparisons and their grades remain unchanged",
    "Deterministic outcomes do not certify every specialist rationale; trace review is Codex-assisted",
    "Automated harness approves the exact proposal; human decision-making and browser UI are not evaluated",
    "Runtime cost is nominal tracked input/cache-read/output accounting, not invoice reconciliation; cache-write counts are not retained",
  ],
  rows,
  sourceHashes: {
    manifest: hash(readFileSync(resolve(run, "manifest.json"))),
    inputs: team.inputSha256,
    selectedProfiles: team.selectedProfilesSha256,
  },
};
if (existsSync(resolve(run, "outcomes.promptfoo.json"))) {
  const native = read("outcomes.promptfoo.json");
  assert.equal(native.results.results.length, rows.length);
  for (const result of native.results.results) {
    const row = rows.find((row) => row.scenario === result.testCase.vars.caseName);
    assert(row);
    assert.equal(result.success, row.passed, "Native outcome grade differs from saved mission");
    assert.equal(result.response.output, JSON.stringify(row, null, 2));
  }
  summary.promptfooOutcomeView = {
    evalId: native.evalId,
    sha256: hash(readFileSync(resolve(run, "outcomes.promptfoo.json"))),
    offlineReplay: true,
  };
}
writeFileSync(resolve(root, "final-team-smoke.json"), JSON.stringify(summary, null, 2) + "\n");
const checks = Object.keys(rows[0].checks);
const config = {
  description: `Final selected team | ${rows.length}/5 missions attempted | saved outcomes, deterministic checks`,
  prompts: ["{{caseName}}"],
  providers: [
    {
      id: "file://" + resolve(root, "final-team-saved-provider.mjs"),
      label: "Final team · medium · Luna + Astra",
    },
  ],
  evaluateOptions: { maxConcurrency: 1, cache: false },
  defaultTest: {
    assert: checks.map((name) => ({
      type: "javascript",
      metric: name,
      value: `const r = JSON.parse(output);\nreturn { pass: r.checks.${name}, score: r.checks.${name} ? 1 : 0, reason: r.error ? r.error : '${name}: ' + r.checks.${name} };`,
    })),
  },
  tests: rows.map((row) => {
    const output = JSON.stringify(row, null, 2);
    return {
      description: row.scenario.replaceAll("_", " ") + " — final team",
      vars: { caseName: row.scenario, savedMission: output, outputSha256: hash(output) },
      metadata: { runId: team.runId, scope: "end-to-end", saved: true },
    };
  }),
};
writeFileSync(
  resolve(run, "outcomes.promptfoo.config.json"),
  JSON.stringify(config, null, 2) + "\n"
);
console.log(
  JSON.stringify(
    {
      runId: team.runId,
      passed: summary.passed,
      missions: rows.length,
      observedRoles: summary.observedRoles,
      estimatedCostUsd: summary.estimatedCostUsd,
      sessionsCleaned: summary.sessionsCleaned,
      config: resolve(run, "outcomes.promptfoo.config.json"),
    },
    null,
    2
  )
);
