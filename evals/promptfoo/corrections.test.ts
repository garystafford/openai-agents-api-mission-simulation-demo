import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  createMission,
  approveCommand,
  requestCommand,
  advanceMission,
} from "../../server/mission.js";
import {
  beginExecution,
  initialConditions,
  createSimulation,
  stepSimulation,
} from "../../server/simulation.js";
import { missionEvidence } from "../../server/mission-evidence.js";
import { benchmarkCases } from "../benchmark-cases.js";
import { actionOracle, evaluateActionSet, compareRanks } from "./oracle.js";
import { prepareReplay } from "./replay.js";
import { testPlan } from "../fixtures.js";
import type { RecordedConsultation } from "../../server/agent-recording.js";
import type { MissionAction } from "../../server/mission-contract.js";

const close = (actual: number, expected: number) =>
  assert(Math.abs(actual - expected) < 1e-7, `${actual} != ${expected}`);
const historical = (id: string): RecordedConsultation =>
  JSON.parse(readFileSync(new URL("./history/v1/cases/" + id + ".json", import.meta.url), "utf8"))
    .record;

test("all plans share the hazard horizon; five calibrated baselines recover and three reduced cases are negative controls", () => {
  for (const { state, variant } of benchmarkCases()) {
    const oracle = actionOracle(state);
    const expected =
      variant === "baseline" || ["dust_storm", "relay_failure"].includes(state.scenario.id);
    assert.equal(oracle.feasible, expected, state.scenario.id + ":" + variant);
    for (const outcome of oracle.outcomes) close(outcome.elapsedMinutes, state.minutesToImpact);
    assert(oracle.acceptable.length > 0);
    if (expected)
      for (const actions of oracle.acceptable) {
        let result = approveCommand(requestCommand(state, testPlan(actions)), true);
        while (result.phase === "executing") result = advanceMission(result);
        assert.equal(result.phase, "resolved", state.scenario.id + ":" + actions);
        close(result.simulation.elapsedMinutes, state.minutesToImpact);
      }
  }
});

test("crew-first reduced rover mitigation beats relay-only partial recovery at a common deadline", () => {
  const record = historical("mission-director--rover_recovery--reduced_reserve");
  const { state } = prepareReplay(record);
  const rescue: MissionAction[] = [
    "recall_eva",
    "deploy_repair_drone",
    "switch_to_backup_relay",
    "shed_nonessential_load",
  ];
  const best = evaluateActionSet(state, rescue);
  const partial = evaluateActionSet(state, ["switch_to_backup_relay"]);
  close(best.elapsedMinutes, 27);
  close(partial.elapsedMinutes, 27);
  assert.equal(best.conditions.crewOutside, 0);
  assert.equal(best.conditions.distanceToSafetyKm, 0);
  assert(best.conditions.batteryPct > 0 && best.conditions.batteryPct < 20);
  assert.equal(best.phase, "failed");
  assert(compareRanks(best.rank, partial.rank) < 0);
  assert.deepEqual(actionOracle(state).acceptable, [rescue]);
  assert.equal(partial.conditions.crewOutside, 2);
});

test("repair alone cannot return a rover crew; recall waits for link and mobility and moves distance with remaining time", () => {
  const state = createMission("rover_recovery");
  const onlyRepair = evaluateActionSet(state, ["deploy_repair_drone", "switch_to_backup_relay"]);
  assert.equal(onlyRepair.conditions.crewOutside, 2);
  assert.equal(onlyRepair.conditions.distanceToSafetyKm, 5);
  assert.equal(onlyRepair.phase, "failed");
  let simulation = beginExecution(state.simulation, [
    "recall_eva",
    "deploy_repair_drone",
    "switch_to_backup_relay",
  ]);
  simulation = stepSimulation(simulation, 27, 12);
  close(simulation.conditions.crewReturnMinutes, 11);
  close(simulation.conditions.distanceToSafetyKm, 5);
  simulation = stepSimulation(simulation, 15, 5.5);
  close(simulation.conditions.crewReturnMinutes, 5.5);
  close(simulation.conditions.distanceToSafetyKm, 2.5);
  simulation = stepSimulation(simulation, 9.5, 5.5);
  assert.equal(simulation.conditions.crewOutside, 0);
  close(simulation.conditions.distanceToSafetyKm, 0);
});

test("historical rover electrical projections include baseline, delayed relay activation, and drone work", () => {
  for (const variant of ["baseline", "reduced_reserve"]) {
    const { state } = prepareReplay(historical("weather-navigation--rover_recovery--" + variant));
    for (const shed of [false, true]) {
      const actions: MissionAction[] = [
        "recall_eva",
        "deploy_repair_drone",
        "switch_to_backup_relay",
        ...(shed ? ["shed_nonessential_load" as const] : []),
      ];
      const c = state.simulation.conditions;
      const simulation = stepSimulation(
        beginExecution(state.simulation, actions),
        27,
        variant === "baseline" ? 12 : 23
      );
      const minutes = variant === "baseline" ? 12 : 23;
      const expected =
        c.batteryPct -
        (c.essentialLoad - c.solarCharge) * minutes -
        c.nonessentialLoad * (shed ? 4 : minutes) -
        0.15 * (minutes - 4) -
        12;
      close(simulation.conditions.batteryPct, expected);
      close(expected, variant === "baseline" ? (shed ? 24.6 : 23.8) : shed ? 12.04 : 9.855);
    }
  }
});

test("coolant repair needs no link, inside crew has no return estimate, and coolant units describe quantity", () => {
  const state = createMission("coolant_leak");
  const c = initialConditions({ ...state.simulation.conditions, communicationsPct: 0 });
  assert.equal(c.crewReturnMinutes, 0);
  assert.equal(c.distanceToSafetyKm, 0);
  const result = stepSimulation(
    beginExecution(createSimulation(c), ["deploy_repair_drone"]),
    24,
    8
  );
  assert.equal(result.commands[0].status, "succeeded");
  close(result.conditions.coolantPct, 95);
  close(result.conditions.coolantFlowLMin, 11.4);
  const reading = missionEvidence(state).telemetry.find((r) => r.metric === "coolantPct")!;
  assert.match(reading.unit!, /quantity/);
});

test("historical solar early recovery fails the hazard-time endurance target; on-time return has zero hazardous exposure and nonzero dose", () => {
  const { state } = prepareReplay(historical("mission-director--solar_flare--baseline"));
  const result = evaluateActionSet(state, [
    "recall_eva",
    "switch_to_backup_relay",
    "shed_nonessential_load",
  ]);
  assert.equal(result.phase, "failed");
  close(result.elapsedMinutes, 22);
  assert(result.conditions.powerEnduranceMinutes < 80);
  assert.equal(result.conditions.crewExposureMinutes, 0);
  assert(result.conditions.crewDoseMsv > 0);
  assert.equal(result.conditions.crewOutside, 0);
});

test("actual battery exhaustion stops commands even when rescue remains incomplete", () => {
  const state = createMission("rover_recovery");
  state.simulation.conditions = initialConditions({
    ...state.simulation.conditions,
    batteryPct: 0.1,
  });
  const stopped = advanceMission(
    approveCommand(
      requestCommand(
        state,
        testPlan(["recall_eva", "switch_to_backup_relay", "deploy_repair_drone"])
      ),
      true
    ),
    4
  );
  assert.equal(stopped.phase, "failed");
  close(stopped.simulation.conditions.batteryPct, 0);
  assert(stopped.simulation.commands.every((c) => c.status === "failed"));
  assert.match(stopped.failureReason!, /exhausted/);
});

test("a final-minute confirmation cannot be replaced by a brief target crossing", () => {
  const state = createMission("relay_failure");
  state.minutesToImpact = 4.5;
  state.simulation.conditions = initialConditions({
    ...state.simulation.conditions,
    communicationsPct: 100,
    backupRelayOnline: 1,
    crewOutside: 0,
  });
  const result = advanceMission(
    approveCommand(requestCommand(state, testPlan(["verify_orbital_weather"])), true),
    5
  );
  assert.equal(result.phase, "failed");
  close(result.simulation.elapsedMinutes, 4.5);
  assert(result.objectiveResults.every((g) => g.met));
  assert.match(result.failureReason!, /confirmation period incomplete/);
  assert.equal(evaluateActionSet(state, ["verify_orbital_weather"]).phase, "failed");
});
