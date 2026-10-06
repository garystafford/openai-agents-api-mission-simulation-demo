// Presentation-only native imports. No providers, judges, or simulations execute.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { directory, loadConsolidatedData } from "./consolidated-data.mjs";
const data = loadConsolidatedData();
const sourceFile = resolve(directory, "results/consolidated-view/complete.promptfoo.json");
const sourceBytes = readFileSync(sourceFile);
const source = JSON.parse(sourceBytes);
const phases = { luna: "A", focused: "B", power: "C" };
const titles = {
  dust_storm: "Dust storm",
  coolant_leak: "Coolant leak",
  relay_failure: "Relay failure",
  solar_flare: "Solar flare",
  rover_recovery: "Rover recovery",
};
function readableCase(id) {
  const [, incident, variation] = id.split("--");
  assert(titles[incident]);
  assert(["baseline", "reduced_reserve"].includes(variation));
  return titles[incident] + " — " + (variation === "baseline" ? "baseline" : "reduced reserves");
}
function sumUsage(usages) {
  const total = {};
  for (const usage of usages)
    for (const [key, value] of Object.entries(usage ?? {})) {
      if (typeof value === "number") total[key] = (total[key] ?? 0) + value;
      else if (value && typeof value === "object") total[key] = sumUsage([total[key], value]);
    }
  return total;
}
const destination = resolve(directory, "results/agent-views");
mkdirSync(destination, { recursive: true });
const manifest = [];
for (const role of data.roles) {
  const groups = data.groups.filter((g) => g.role === role);
  const originals = source.results.results.filter((r) => r.metadata.role === role);
  const cases = [...new Set(originals.map((r) => r.testCase.vars.caseId))].sort();
  assert.equal(cases.length, 9);
  const columns = groups.map((g) => ({
    key: g.phase + "::" + g.model + ":" + g.effort,
    label:
      g.model
        .replace("gpt-6-", "GPT-6 ")
        .replace(/\b(luna|sol|astra)\b/g, (x) => x[0].toUpperCase() + x.slice(1)) +
      " / " +
      g.effort +
      " [" +
      phases[g.phase] +
      "]",
    group: g,
  }));
  const tests = cases.map((caseId) => ({
    description: readableCase(caseId),
    vars: {},
    metadata: { caseId, role },
  }));
  const rows = originals.map((original) => {
    const row = structuredClone(original);
    const caseId = original.testCase.vars.caseId;
    row.id = randomUUID();
    row.testIdx = cases.indexOf(caseId);
    row.promptIdx = columns.findIndex((c) => c.key === row.metadata.phase + "::" + row.provider.id);
    assert(row.promptIdx >= 0);
    const column = columns[row.promptIdx];
    row.provider = { id: column.key, label: column.label };
    row.testCase = { ...structuredClone(tests[row.testIdx]), assert: row.testCase.assert };
    row.vars = {};
    row.metadata = { ...row.metadata, caseId, presentationOnly: true };
    // Session references remain in cell metadata without occupying a variable column.
    if (row.response?.metadata?.sessionId) {
      row.metadata.sourceSessionId = row.response.metadata.sessionId;
      delete row.response.metadata.sessionId;
    }
    return row;
  });
  const prompts = columns.map((column, index) => {
    const cells = rows.filter((r) => r.promptIdx === index);
    assert.equal(cells.length, 9);
    assert.equal(cells.filter((r) => r.success).length, column.group.passed);
    const components = cells.flatMap((r) => r.gradingResult?.componentResults ?? []);
    const raw = "Frozen case replay";
    const id = createHash("sha256").update(raw).digest("hex");
    cells.forEach((r) => {
      r.promptId = id;
      r.prompt.label = "Saved case";
    });
    return {
      id,
      raw,
      label: "Saved case",
      provider: column.label,
      metrics: {
        score: cells.reduce((n, r) => n + r.score, 0),
        testPassCount: cells.filter((r) => r.success).length,
        testFailCount: cells.filter((r) => !r.success && r.failureReason !== 2).length,
        testErrorCount: cells.filter((r) => r.failureReason === 2).length,
        assertPassCount: components.filter((r) => r.pass).length,
        assertFailCount: components.filter((r) => !r.pass).length,
        totalLatencyMs: cells.reduce((n, r) => n + r.latencyMs, 0),
        tokenUsage: sumUsage(cells.map((r) => r.tokenUsage)),
        namedScores: {},
        namedScoresCount: {},
        namedScoreWeights: {},
        ...(cells.some((r) => r.metadata.candidateCostUnknown)
          ? {}
          : { cost: cells.reduce((n, r) => n + (r.cost ?? 0), 0) }),
      },
    };
  });
  const choice = data.choices.find((p) => p.role === role);
  const metadata = {
    ...source.metadata,
    role,
    sourceConsolidatedSha256: createHash("sha256").update(sourceBytes).digest("hex"),
    roleGroups: groups,
    finalChoice: choice,
    notes:
      "Presentation only. A = calibrated Luna sweep; B = corrected evidence screen; C = Power follow-up. Keep phases distinct. Both checks are required; assertion averages are not complete-pass rates. Risk Astra-high is 7/9 complete attempts; native headers show 7/8 plus one error. Missing usage is unknown; cost excludes judge charges. No paid runs.",
  };
  const output = {
    results: {
      version: 3,
      timestamp: new Date().toISOString(),
      prompts,
      results: rows,
      stats: {
        successes: rows.filter((r) => r.success).length,
        failures: rows.filter((r) => !r.success && r.failureReason !== 2).length,
        errors: rows.filter((r) => r.failureReason === 2).length,
        tokenUsage: sumUsage(rows.map((r) => r.tokenUsage)),
      },
    },
    config: {
      description: `${role} — 9 cases | ${choice.model.replace("gpt-6-", "")}/${choice.reasoningEffort} selected | saved grades; phases A/B/C separate`,
      prompts: ["Frozen case replay"],
      providers: columns.map((c) => ({ id: c.key, label: c.label })),
      tests,
      metadata,
      defaultTest: {},
    },
    metadata,
    vars: [],
  };
  assert.equal(rows.length, 9 * columns.length);
  assert.equal(new Set(rows.map((r) => r.testIdx + ":" + r.promptIdx)).size, rows.length);
  for (const row of rows) {
    const original =
      originals.find(
        (r) =>
          r.metadata.phase === row.metadata.phase &&
          r.metadata.caseId === row.metadata.caseId &&
          r.provider.id === row.provider.id.split("::")[1]
      ) ??
      originals.find(
        (r) =>
          r.metadata.phase === row.metadata.phase &&
          r.testCase.vars.caseId === row.metadata.caseId &&
          r.provider.id === row.provider.id.split("::")[1]
      );
    assert(original);
    assert.equal(row.response?.output, original.response?.output);
    assert.deepEqual(row.gradingResult, original.gradingResult);
    assert.equal(row.failureReason, original.failureReason);
  }
  const slug = role.toLowerCase().replaceAll(" & ", "-").replaceAll(" ", "-");
  const file = resolve(destination, slug + ".promptfoo.json");
  writeFileSync(file, JSON.stringify(output, null, 2) + "\n");
  manifest.push({
    role,
    file,
    cases: 9,
    columns: columns.length,
    attempts: rows.length,
    passes: groups.map((g) => ({
      phase: phases[g.phase],
      model: g.model,
      effort: g.effort,
      passed: g.passed,
    })),
    apiCalls: 0,
  });
}
assert.equal(
  manifest.reduce((sum, item) => sum + item.attempts, 0),
  207
);
writeFileSync(resolve(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(
  JSON.stringify(
    manifest.map(({ role, cases, columns, attempts }) => ({ role, cases, columns, attempts }))
  )
);
