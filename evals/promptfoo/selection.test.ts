import assert from "node:assert/strict";
import test from "node:test";
import { selectProfiles } from "./report-regrade.js";
import { validationInputs } from "./validation-inputs.js";
import { validationRubric, auditRecord } from "./validation-cases.js";
import { loadCase, loadManifest } from "./dataset.js";
import { validateJudgeScope } from "./judge-scope.js";
import { sha256 } from "./saved-comparison.js";
import { readFileSync } from "node:fs";
import { assertComparisonReleased } from "./execution-policy.js";

test("selection prioritizes complete correctness, then original candidate latency", () => {
  const groups = [
    {
      role: "example",
      effort: "low",
      passed: 7,
      cases: 9,
      originalMedianLatencyMs: 10,
      candidateCost: 0,
    },
    {
      role: "example",
      effort: "medium",
      passed: 8,
      cases: 9,
      originalMedianLatencyMs: 40,
      candidateCost: null,
    },
    {
      role: "example",
      effort: "high",
      passed: 8,
      cases: 9,
      originalMedianLatencyMs: 50,
      candidateCost: 0,
    },
  ];
  assert.equal(selectProfiles(groups)[0].reasoningEffort, "medium");
  groups[1].originalMedianLatencyMs = 50;
  assert.equal(selectProfiles(groups)[0].reasoningEffort, "medium");
  groups.forEach((group) => {
    group.passed = 6;
  });
  assert.equal(selectProfiles(groups)[0].exploratoryQualityGateMet, false);
});

test("validation repeats identical new initial conditions with independent mission IDs", () => {
  const inputs = validationInputs();
  assert.equal(inputs.length, 10);
  assert.equal(new Set(inputs.map(({ state }) => state.missionId)).size, 10);
  assert.equal(new Set(inputs.map(({ conditionsSha256 }) => conditionsSha256)).size, 5);
  for (let index = 0; index < 10; index += 2) {
    assert.equal(inputs[index].conditionsSha256, inputs[index + 1].conditionsSha256);
    assert.deepEqual(
      inputs[index].state.simulation.conditions,
      inputs[index + 1].state.simulation.conditions
    );
  }
});

test("fresh semantic evidence excludes private state, answers and future session context", () => {
  const record = structuredClone(loadCase(loadManifest().cases[0].id).record);
  record.output = "CURRENT_ANSWER_NOT_A_REFERENCE";
  record.state.simulation = Object.assign(record.state.simulation, {
    hiddenMarker: "PRIVATE_ORACLE_MARKER",
  });
  const earlier = {
    ...record,
    id: "earlier",
    startedAt: "2000-01-01T00:00:00Z",
    output: "EARLIER_VISIBLE_CONTEXT",
  };
  const future = {
    ...record,
    id: "future",
    startedAt: "2100-01-01T00:00:00Z",
    output: "FUTURE_CONTEXT_MARKER",
  };
  record.sessionId = earlier.sessionId = future.sessionId = "same-session";
  const rubric = validationRubric(record, [earlier, future]);
  assert(rubric.includes("EARLIER_VISIBLE_CONTEXT"));
  for (const marker of [
    "PRIVATE_ORACLE_MARKER",
    "CURRENT_ANSWER_NOT_A_REFERENCE",
    "FUTURE_CONTEXT_MARKER",
  ])
    assert(!rubric.includes(marker));
});

test("recording audit parses tool arguments and preserves explicit tool failure", () => {
  const record = structuredClone(loadCase(loadManifest().cases[0].id).record);
  record.output = '{"actions":[]}';
  record.tools = [
    {
      call: {
        type: "function_call",
        name: "submit_mission_plan",
        arguments: record.output,
        call_id: "c",
        turn_id: "t",
      },
      result: {
        type: "agent.session.input.tool_result",
        call_id: "c",
        turn_id: "t",
        success: false,
        error: "rejected",
      },
    },
  ];
  const audit = JSON.parse(auditRecord(record));
  assert.deepEqual(audit.tools[0].arguments, audit.answer);
  assert.equal(audit.tools[0].success, false);
});

test("fresh judge scope binds the actual bounded number of saved validation reports", () => {
  const output = "saved";
  const scope = {
    kind: "validation" as const,
    runId: "judge-validation-2026-10-04T22-00-00Z",
    expiresAt: "2100-01-01T00:00:00Z",
    maxCalls: 1,
    records: [
      {
        key: "validation::case",
        outputSha256: sha256(JSON.stringify(output)),
        rubricSha256: sha256("rubric"),
      },
    ],
  };
  assert.equal(
    validateJudgeScope(
      scope,
      { savedKey: "validation::case", output, rubric: "rubric" },
      scope.runId,
      []
    ),
    "validation::case"
  );
  assert.throws(() =>
    validateJudgeScope(
      { ...scope, maxCalls: 2 },
      { savedKey: "validation::case", output, rubric: "rubric" },
      scope.runId,
      []
    )
  );
  assert.throws(() =>
    validateJudgeScope(
      scope,
      { savedKey: "validation::case", output, rubric: "rubric" },
      scope.runId,
      ["validation::case"]
    )
  );
});

test("a label amendment preserves the original pilot disagreement and exact answer identity", () => {
  const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
  const amendment = read("./calibration/label-amendments.json");
  const original = read("./calibration/history/materiality-v3-pilot/anchors.json");
  const current = read("./calibration/anchors.json");
  const pilot = read("./calibration/judge-calibration.json");
  assert.equal(pilot.agreements, 26);
  assert.equal(amendment.policyChanged, false);
  for (const row of amendment.amendments) {
    const before = original.anchors.find((anchor: { key: string }) => anchor.key === row.key);
    const after = current.anchors.find((anchor: { key: string }) => anchor.key === row.key);
    assert.equal(before.semanticVerdict, row.previousVerdict);
    assert.equal(after.semanticVerdict, row.semanticVerdict);
    assert.equal(before.outputSha256, after.outputSha256);
    assert.equal(after.outputSha256, row.outputSha256);
  }
});

test("a judge permit outside its exact local run fails before loading a provider", () => {
  const oldPath = process.env.MARS_JUDGE_AUTHORIZATION_FILE;
  const oldRun = process.env.MARS_JUDGE_CALIBRATION_RUN;
  try {
    process.env.MARS_JUDGE_AUTHORIZATION_FILE = "/tmp/unrelated-judge-permit.json";
    process.env.MARS_JUDGE_CALIBRATION_RUN = "judge-adjudication-2026-10-04T22-00-00Z";
    assert.throws(() => assertComparisonReleased("judge"), /Judge permit must belong to its run/);
  } finally {
    if (oldPath === undefined) delete process.env.MARS_JUDGE_AUTHORIZATION_FILE;
    else process.env.MARS_JUDGE_AUTHORIZATION_FILE = oldPath;
    if (oldRun === undefined) delete process.env.MARS_JUDGE_CALIBRATION_RUN;
    else process.env.MARS_JUDGE_CALIBRATION_RUN = oldRun;
  }
});
