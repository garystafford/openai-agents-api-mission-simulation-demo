import assert from "node:assert/strict";
import { test } from "node:test";
import { validateFocusedClaim } from "./focused-artifacts.js";
import { validateJudgeScope } from "./judge-scope.js";
import { orderFocused } from "./report-focused.js";
import { sha256 } from "./saved-comparison.js";
const scope = {
  runId: "focused-models-2026-10-04T23-00-00Z",
  expiresAt: "2027-01-01T00:00:00Z",
  maxCalls: 54,
  estimatedBudgetUsd: 12,
  records: Array.from({ length: 54 }, (_, i) => ({
    key: "case" + i,
    fixtureSha256: "frozen",
    reservationUsd: 2,
  })),
};
const now = Date.parse("2026-10-04T23:00:00Z");
test("focused candidate scope rejects duplicate attempts, changed fixtures and out-of-matrix calls", () => {
  assert.equal(validateFocusedClaim(scope, "case0", "frozen", [], scope.runId, now).key, "case0");
  assert.throws(() => validateFocusedClaim(scope, "case0", "changed", [], scope.runId, now));
  assert.throws(() => validateFocusedClaim(scope, "case54", "frozen", [], scope.runId, now));
  assert.throws(() =>
    validateFocusedClaim(
      scope,
      "case0",
      "frozen",
      [{ phase: "started", key: "case0" }],
      scope.runId,
      now
    )
  );
  assert.throws(() => validateFocusedClaim(scope, "case0", "frozen", [], "wrong-run", now));
});
test("focused authorization bounds attempts, expiry and outstanding cost estimates", () => {
  assert.throws(() =>
    validateFocusedClaim({ ...scope, maxCalls: 72 }, "case0", "frozen", [], scope.runId, now)
  );
  assert.throws(() =>
    validateFocusedClaim(scope, "case0", "frozen", [], scope.runId, Date.parse(scope.expiresAt))
  );
  const pending = Array.from({ length: 6 }, (_, i) => ({
    phase: "started",
    key: "case" + (i + 1),
    reservationUsd: 2,
  }));
  assert.throws(() => validateFocusedClaim(scope, "case0", "frozen", pending, scope.runId, now));
  assert.equal(
    validateFocusedClaim(
      scope,
      "case0",
      "frozen",
      [
        ...pending,
        ...pending.map((row) => ({ phase: "completed", key: row.key, chargedEstimateUsd: 0.1 })),
      ],
      scope.runId,
      now
    ).key,
    "case0"
  );
});
test("native focused judge authorization binds the parsed answer and rubric", () => {
  const output = { answer: { summary: "example" }, tools: [] };
  const judged = {
    kind: "focused" as const,
    runId: "judge-focused-2026-10-04T23-00-00Z",
    expiresAt: scope.expiresAt,
    maxCalls: 1,
    records: [
      { key: "one", outputSha256: sha256(JSON.stringify(output)), rubricSha256: sha256("rubric") },
    ],
  };
  const vars = { savedKey: "one", output, rubric: "rubric" };
  assert.equal(validateJudgeScope(judged, vars, judged.runId, [], now), "one");
  assert.throws(() => validateJudgeScope(judged, { ...vars, output: {} }, judged.runId, [], now));
  assert.throws(() => validateJudgeScope(judged, vars, judged.runId, ["one"], now));
});
test("Sol low can win at nine of nine; reasoning level has no automatic quality preference", () => {
  const rows = [
    { model: "gpt-6-sol", effort: "high", passed: 9, medianCandidateMs: 50000 },
    { model: "gpt-6-sol", effort: "low", passed: 9, medianCandidateMs: 15000 },
    { model: "gpt-6-astra", effort: "medium", passed: 8, medianCandidateMs: 10000 },
  ];
  assert.equal(orderFocused(rows)[0].effort, "low");
  assert.equal(
    orderFocused([
      { ...rows[0], passed: 9 },
      { ...rows[1], passed: 8 },
    ])[0].effort,
    "high"
  );
});

test("Power-only authorization permits exactly its 18 bound attempts", () => {
  const power = { ...scope, maxCalls: 18, records: scope.records.slice(0, 18) };
  assert.equal(validateFocusedClaim(power, "case0", "frozen", [], power.runId, now).key, "case0");
  assert.throws(() => validateFocusedClaim(power, "case18", "frozen", [], power.runId, now));
  assert.throws(() =>
    validateFocusedClaim(
      { ...power, records: scope.records },
      "case0",
      "frozen",
      [],
      power.runId,
      now
    )
  );
});
