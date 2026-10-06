import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { gradeEpisode } from "./assertions.js";
import { loadCase, loadManifest } from "./dataset.js";
import {
  boundaryRules,
  buildRubric,
  caseGradingContract,
  gradingVersion,
} from "./grading-policy.js";
import HeldJudgeProvider, { validateJudgeResponse } from "./held-judge.js";
import { assertOperationReleased } from "./execution-policy.js";
import { validateJudgeScope } from "./judge-scope.js";
import { priceJudgeUsage } from "./report-judge-calibration.js";
import { buildOfflineReview, validateAnchors } from "./offline-review.js";
import SavedOutputProvider from "./saved-output-provider.js";
import { loadSavedComparison, savedKey, sha256, validateSavedRows } from "./saved-comparison.js";

const savedArchive = {
  skip:
    !existsSync(new URL("./results/2026-10-04T17-05-36.658Z.json", import.meta.url)) &&
    "Local ignored raw comparison export is unavailable",
};

test("judge cost separates cache reads and writes and counts reasoning only within output", () => {
  const usage = {
    input_tokens: 1000,
    output_tokens: 200,
    input_tokens_details: { cached_tokens: 100, cache_write_tokens: 800 },
    output_tokens_details: { reasoning_tokens: 150 },
  };
  assert.equal(priceJudgeUsage(usage), (100 * 2 + 100 * 0.2 + 800 * 2.5 + 200 * 10) / 1e6);
  assert.equal(
    priceJudgeUsage({ ...usage, output_tokens_details: { reasoning_tokens: 0 } }),
    priceJudgeUsage(usage)
  );
  assert.throws(() => priceJudgeUsage({ ...usage, input_tokens: 899 }), /exceed input/);
  assert.throws(() => priceJudgeUsage({ ...usage, input_tokens: 272001 }), /Long-context/);
});

test("calibration scope binds output, rubric, run, expiry and one attempt per reviewed example", () => {
  const vars = { savedKey: "case-0", output: { answer: "saved" }, rubric: "frozen" };
  const scope = {
    runId: "fixture",
    expiresAt: new Date(2000).toISOString(),
    maxCalls: 27,
    records: Array.from({ length: 27 }, (_, i) => ({
      key: "case-" + i,
      outputSha256: sha256(JSON.stringify(vars.output)),
      rubricSha256: sha256(vars.rubric),
    })),
  };
  assert.equal(validateJudgeScope(scope, vars, "fixture", [], 1000), "case-0");
  assert.throws(() => validateJudgeScope(scope, vars, "other", [], 1000), /authorization mismatch/);
  assert.throws(() => validateJudgeScope(scope, vars, "fixture", [], 2000), /expired/);
  assert.throws(
    () => validateJudgeScope(scope, vars, "fixture", ["case-0"], 1000),
    /already attempted/
  );
  assert.throws(
    () =>
      validateJudgeScope(scope, { ...vars, savedKey: "full-regrade-case" }, "fixture", [], 1000),
    /outside authorized/
  );
  assert.throws(
    () =>
      validateJudgeScope(scope, { ...vars, output: { answer: "changed" } }, "fixture", [], 1000),
    /output differs/
  );
  assert.throws(
    () => validateJudgeScope(scope, { ...vars, rubric: "changed" }, "fixture", [], 1000),
    /rubric differs/
  );
  assert.throws(
    () => validateJudgeScope(scope, vars, "fixture", Array(27).fill("other"), 1000),
    /limit reached/
  );
});

test(
  "small judge calibration selects exactly the 27 reviewed outputs without label leakage",
  savedArchive,
  async () => {
    process.env.PROMPTFOO_DISABLE_TELEMETRY = "1";
    const { UnifiedConfigSchema } = await import("promptfoo");
    const { default: config } = await import("./judge-calibration-config.js");
    assert(UnifiedConfigSchema.safeParse(config).success);
    assert.equal(config.tests.length, 27);
    assert.equal(config.evaluateOptions.repeat, 1);
    assert.equal(config.evaluateOptions.maxConcurrency, 2);
    assert.equal(
      (config.defaultTest.assert[1].provider!.config as Record<string, unknown>).maxRetries,
      0
    );
    assert(config.tests.every((item) => !item.vars.rubric.includes('"semanticVerdict"')));
  }
);

test("judge-only authorization cannot release new candidate episodes and missing scope fails closed", () => {
  const policy = { status: "released", reason: "fixture", allowedOperations: ["judge"] };
  assert.doesNotThrow(() => assertOperationReleased(policy, "judge"));
  assert.throws(() => assertOperationReleased(policy, "candidate"), /not authorized/);
  assert.throws(
    () => assertOperationReleased({ status: "released", reason: "fixture" }, "judge"),
    /not authorized/
  );
  assert.throws(
    () => assertOperationReleased({ ...policy, status: "on_hold" }, "judge"),
    /disabled/
  );
});

test("full regrade authorization is exactly 135 bound saved outputs, separate from calibration", () => {
  const vars = { savedKey: "case-0", output: { answer: "saved" }, rubric: "frozen" };
  const scope = {
    kind: "regrade" as const,
    runId: "full",
    expiresAt: new Date(2000).toISOString(),
    maxCalls: 135,
    records: Array.from({ length: 135 }, (_, i) => ({
      key: "case-" + i,
      outputSha256: sha256(JSON.stringify(vars.output)),
      rubricSha256: sha256(vars.rubric),
    })),
  };
  assert.equal(validateJudgeScope(scope, vars, "full", [], 1000), "case-0");
  assert.throws(
    () => validateJudgeScope({ ...scope, maxCalls: 27 }, vars, "full", [], 1000),
    /Wrong bounded/
  );
  assert.throws(
    () => validateJudgeScope({ ...scope, records: scope.records.slice(1) }, vars, "full", [], 1000),
    /Wrong bounded/
  );
});

test("all 45 scoped contracts omit hidden outcome oracles and do not inherit old checklist requirements", () => {
  for (const entry of loadManifest().cases) {
    const item = loadCase(entry.id);
    const contract = caseGradingContract(item);
    assert.equal(contract.role, entry.role);
    assert(contract.materialRequirements.length >= 3);
    assert.match(contract.sourceContractInterpretation, /not explicitly bound/);
    assert(!buildRubric(item).includes('"actionOracle"'));
  }
  const life = caseGradingContract(loadCase("life-support--relay_failure--baseline"));
  assert.match(life.materialRequirements.join(" "), /narrow cabin consultation/);
  assert.match(life.materialRequirements.join(" "), /nonexhaustive|exhaustive missing-sensor/);
  const power = buildRubric(loadCase("power-thermal--coolant_leak--baseline"));
  assert.match(power, /No mandatory repetition of initial endurance/);
  assert.match(power, /Never return fractional scores/);
  assert.match(power, /NEEDS_REVIEW/);
});

test("semantic contract rejects fractional/inconsistent judgments and preserves abstentions and usage", () => {
  for (const [reason, pass, score] of [
    ["PASS: role question answered", true, 1],
    ["FAIL: wrong final timing", false, 0],
    ["NEEDS_REVIEW: ambiguous source", false, 0],
  ] as const) {
    const result = validateJudgeResponse({
      output: JSON.stringify({ reason, pass, score }),
      tokenUsage: { total: 50 },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.tokenUsage?.total, 50);
    assert.equal(JSON.parse(result.output as string).pass, pass);
    assert.equal(result.metadata?.semanticVerdict, reason.split(":")[0]);
  }
  for (const value of [
    { reason: "PASS: correct", pass: true, score: 0.97 },
    { reason: "FAIL: wrong", pass: true, score: 1 },
    { reason: "NEEDS_REVIEW: source ambiguity", pass: true, score: 1 },
    { reason: "unclassified", pass: false, score: 0 },
  ])
    assert.equal(
      validateJudgeResponse({ output: JSON.stringify(value) }).metadata?.semanticVerdict,
      "JUDGE_ERROR"
    );
  assert(validateJudgeResponse({ output: "not JSON" }).error);
});

test("paid grader stays held even with live activation, before loading or calling a provider", async () => {
  const old = process.env.MARS_PROMPTFOO_LIVE;
  process.env.MARS_PROMPTFOO_LIVE = "1";
  try {
    await assert.rejects(
      new HeldJudgeProvider().callApi("no paid calls"),
      /Paid Promptfoo comparison is disabled/
    );
  } finally {
    if (old === undefined) delete process.env.MARS_PROMPTFOO_LIVE;
    else process.env.MARS_PROMPTFOO_LIVE = old;
  }
});

test(
  "saved sweep replays all 135 deterministic grades without network calls or modifying raw results",
  savedArchive,
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("Network forbidden in offline calibration");
    };
    try {
      const rawPath = new URL("./results/2026-10-04T17-05-36.658Z.json", import.meta.url);
      const before = sha256(readFileSync(rawPath));
      const { plan, contracts } = buildOfflineReview();
      assert.equal(plan.count, 135);
      assert.equal(plan.deterministicPassed, 133);
      assert.equal(plan.deterministicChanges, 0);
      assert.equal(contracts.length, 45);
      assert.equal(plan.reviewCounts.not_reviewed, 108);
      assert.equal(plan.reviewCounts.needs_review, 0);
      assert.equal(plan.reviewCounts.pass, 16);
      assert.equal(plan.reviewCounts.fail, 11);
      assert.equal(plan.labelRevision, "materiality-v3-labels-r2");
      assert.equal(plan.rubricStatus, "finalized_offline");
      assert.equal(plan.resolvedAdjudications, 4);
      assert.equal(plan.independentHumanApproval, false);
      assert.equal(plan.paidStatus, "on_hold");
      assert.equal(sha256(readFileSync(rawPath)), before);
      const saved = loadSavedComparison();
      const result = await new SavedOutputProvider().callApi(savedKey(saved.rows[0]));
      assert.equal(result.output, saved.rows[0].response.output);
      assert.equal(result.cost, 0); // Local retrieval cost, not original candidate cost.
      assert.equal(result.tokenUsage.total, 0);
      assert.equal(result.metadata.originalCandidate, saved.rows[0].provider.id);
      assert.equal(
        plan.records.find(
          (r) => r.key === "risk-review--rover_recovery--baseline::gpt-6-luna:medium"
        )?.proposedEpisodeVerdict,
        "fail"
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
);

test(
  "saved row coverage and anchor provenance fail closed on duplicates and stale edits",
  savedArchive,
  () => {
    const saved = loadSavedComparison();
    const anchors = JSON.parse(
      readFileSync(new URL("./calibration/anchors.json", import.meta.url), "utf8")
    ).anchors;
    validateAnchors(anchors, saved.rows);
    assert.throws(() => validateSavedRows(saved.rows.slice(1)), /Incomplete/);
    assert.throws(
      () => validateSavedRows([saved.rows[0], ...saved.rows.slice(0, -1)]),
      /Duplicate/
    );
    assert.throws(
      () => validateAnchors([{ ...anchors[0], outputSha256: "stale" }], saved.rows),
      /binding is stale/
    );
    assert.throws(
      () => validateAnchors([{ ...anchors[0], recordId: "stale" }], saved.rows),
      /native ID is stale/
    );
    assert.throws(
      () =>
        validateAnchors([{ ...anchors[0], candidateEvidence: "invented quotation" }], saved.rows),
      /quote not in/
    );
    assert.throws(() => validateAnchors([anchors[0], anchors[0]], saved.rows), /Duplicate anchor/);
  }
);

test(
  "proposal identity ignores object field order but retains changed content and array order",
  savedArchive,
  () => {
    const row = loadSavedComparison().rows.find(
      (r) => savedKey(r) === "mission-director--dust_storm--baseline::gpt-6-luna:low"
    )!;
    const episode = JSON.parse(row.response.output);
    const submit = episode.tools.find(
      (tool: { name: string }) => tool.name === "submit_mission_plan"
    );
    submit.arguments = Object.fromEntries(Object.entries(submit.arguments).reverse());
    const item = loadCase(row.testCase.vars.caseId);
    assert.equal(gradeEpisode(JSON.stringify(episode), item).pass, true);
    submit.arguments.actions = [...submit.arguments.actions].reverse();
    assert.match(gradeEpisode(JSON.stringify(episode), item).reason, /matching pending submission/);
  }
);

test("malformed audits are clean failures and reordered duplicate argument objects still count as duplicates", () => {
  const item = loadCase("life-support--coolant_leak--baseline");
  for (const tools of [null, [null], [{ name: "mcp_read_mission_telemetry", success: "true" }]])
    assert.equal(gradeEpisode(JSON.stringify({ answer: {}, tools }), item).pass, false);
  const answer = {
    status: "watch",
    confidence: 0.7,
    recommendation: "Request authorization",
    evidence: ["Baseline"],
    tradeoff: "Unmeasured cabin conditions",
  };
  assert.equal(
    gradeEpisode(
      JSON.stringify({ answer, tools: [{ name: "mcp_read_mission_telemetry", success: true }] }),
      item
    ).pass,
    false,
    "A valid answer cannot make a missing arguments field a valid audit"
  );
  const tools = [
    { name: "mcp_read_mission_telemetry", success: true, arguments: { system: "all", fixture: 1 } },
    { name: "mcp_read_mission_telemetry", success: true, arguments: { fixture: 1, system: "all" } },
  ];
  assert.match(
    gradeEpisode(JSON.stringify({ answer, tools }), item).reason,
    /Repeated evidence source/
  );
});

test(
  "finalized boundary decisions remain bound to the four saved answers without changing hard gates",
  savedArchive,
  () => {
    const { plan } = buildOfflineReview();
    const expected = new Map([
      ["weather-navigation--dust_storm--reduced_reserve::gpt-6-luna:medium", "pass"],
      ["mission-director--relay_failure--reduced_reserve::gpt-6-luna:high", "fail"],
      ["life-support--solar_flare--reduced_reserve::gpt-6-luna:high", "fail"],
      ["risk-review--solar_flare--reduced_reserve::gpt-6-luna:medium", "pass"],
    ]);
    for (const [key, verdict] of expected) {
      const row = plan.records.find((record) => record.key === key)!;
      assert.equal(row.semanticReview, verdict);
      assert.equal(row.proposedEpisodeVerdict, verdict);
      assert.equal(row.deterministic.pass, true);
    }
    assert.equal(plan.gradingVersion, gradingVersion);
    assert.equal(plan.deterministicChanges, 0);
    assert.equal(new Set(boundaryRules.map((rule) => rule.id)).size, 4);
    assert.equal(plan.independentHumanApproval, false);
  }
);

test("adjudication facts distinguish missing public mappings, missing atmosphere and qualitative horizons", () => {
  const weather = loadCase("weather-navigation--dust_storm--reduced_reserve");
  const publicWeather = weather.review.facts[0] as { recallPrerequisites: Record<string, unknown> };
  assert.equal(publicWeather.recallPrerequisites.mobilityAtLeastPct, 50);
  assert.equal(
    publicWeather.recallPrerequisites.mobilityMetric,
    undefined,
    "Do not retrospectively expose an unpublished metric binding"
  );
  const director = loadCase("mission-director--relay_failure--reduced_reserve");
  const capabilities = director.review.facts[1] as { actionCapabilities: Record<string, string> };
  assert.match(capabilities.actionCapabilities.switch_to_backup_relay, /communications to 100%/);
  assert.doesNotMatch(capabilities.actionCapabilities.switch_to_backup_relay, /packet.?loss/i);
  const life = loadCase("life-support--solar_flare--reduced_reserve");
  assert.match(
    life.record.input,
    /missing readings; distinguish nominal observed systems from unmeasured ones/
  );
  const publicLife = life.review.facts[0] as { telemetry: Array<{ metric?: string }> };
  assert(publicLife.telemetry.some((reading) => reading.metric === "airProcessingPct"));
  for (const metric of ["oxygenPct", "carbonDioxidePpm", "cabinPressureKpa"])
    assert(!publicLife.telemetry.some((reading) => reading.metric === metric));
  const risk = loadCase("risk-review--solar_flare--reduced_reserve");
  assert.match(
    risk.record.input,
    /Identify any unsafe assumption or objective that may remain unmet through minute 23/
  );
  assert(
    (38.9 - 0.6) / 0.6 < 80,
    "Under the candidate's stated steady draw, the identified endurance shortfall persists to minute 23"
  );
  // This contrast prevents the qualitative exception from waiving an explicit numeric request.
  const power = loadCase("power-thermal--solar_flare--reduced_reserve");
  assert.match(power.record.input, /project battery and endurance at minute 22 and minute 23/);
  assert.match(
    caseGradingContract(power).materialRequirements.join(" "),
    /Report both requested forecast times/
  );
});

test(
  "judge-only Promptfoo configuration covers each original output exactly once without role sessions",
  savedArchive,
  async () => {
    process.env.PROMPTFOO_DISABLE_TELEMETRY = "1";
    const { UnifiedConfigSchema } = await import("promptfoo");
    const { default: config } = await import("./regrade-config.js");
    assert(UnifiedConfigSchema.safeParse(config).success);
    assert.equal(config.providers.length, 1);
    assert.match(config.providers[0].id, /saved-output-provider/);
    assert.equal(config.tests.length, 135);
    assert.equal(new Set(config.tests.map((item) => item.vars.savedKey)).size, 135);
    assert.match(config.defaultTest.assert[1].provider!.id, /held-judge/);
    assert(
      config.tests.every((item) => !item.vars.rubric.includes('"semanticVerdict"')),
      "Target calibration labels must not leak into the judge prompt"
    );
  }
);
