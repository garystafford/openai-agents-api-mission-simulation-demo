import assert from "node:assert/strict";
import { test } from "node:test";
test("benchmark matrix varies all five incidents and includes failed runs in its denominator", async () => {
  const { benchmarkCases, summarizeBenchmark } = await import("./benchmark-cases.js");
  const cases = benchmarkCases(2);
  assert.equal(cases.length, 20);
  assert.equal(new Set(cases.map((item) => item.state.missionId)).size, 20);
  for (const scenario of new Set(cases.map((item) => item.state.scenario.id))) {
    const pair = cases.filter((item) => item.state.scenario.id === scenario && item.repeat === 1);
    assert(
      pair[0].state.simulation.conditions.batteryPct >
        pair[1].state.simulation.conditions.batteryPct
    );
  }
  const base = {
    scenario: "dust_storm",
    variant: "baseline",
    repeat: 1,
    elapsedMs: 10,
    consultations: 1,
    validationRetries: 0,
    unmet: [],
  };
  const summary = summarizeBenchmark([
    { ...base, status: "resolved", approvalReadyMs: 8, estimatedCostUsd: 0.1 },
    { ...base, status: "error" },
  ]);
  assert.equal(summary.resolutionRate, 0.5);
  assert.equal(summary.estimatedCostUsd, undefined);
  assert.equal(summary.approvalReadyP50Ms, 8);
});

test("fault benchmark variants retain deterministic reproduction metadata", async () => {
  const { benchmarkCases } = await import("./benchmark-cases.js");
  const cases = benchmarkCases(1, ["repair_failure", "delayed_sensors", "compound"], "fault-suite");
  assert.equal(cases.length, 15);
  assert(cases.every((item) => item.state.variation?.seed.startsWith("fault-suite:")));
  assert(cases.some((item) => item.state.simulation.sensorDelaySeconds === 96));
  assert(
    cases.some((item) =>
      item.state.simulation.disturbances?.some((fault) => fault.kind === "repair_failure")
    )
  );
});
