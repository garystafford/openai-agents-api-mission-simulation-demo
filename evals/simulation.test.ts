import { testPlan } from "./fixtures.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceMission,
  approveCommand,
  createMission,
  requestCommand,
  scenarioIds,
  type MissionAction,
  type MissionState,
} from "../server/mission.js";
import { initialConditions, objectiveResults, stepSimulation } from "../server/simulation.js";

function dispatch(state: MissionState, actions: MissionAction[]) {
  return approveCommand(requestCommand(state, testPlan(actions)), true);
}
function finish(state: MissionState) {
  for (let i = 0; i < 20 && state.phase === "executing"; i++) state = advanceMission(state);
  return state;
}
function observe(state: MissionState) {
  for (let i = 0; i < 3; i++) state = advanceMission(state);
  return state;
}

test("approval preparation preserves the exact proposal and never fills or filters it", () => {
  const state = createMission();
  const plan = { ...testPlan(["recall_eva"]), headline: "  Preserve this wording  " };
  assert.deepEqual(requestCommand(state, plan).selectedPlan, plan);
  assert.throws(() => requestCommand(state, { actions: ["recall_eva"] } as typeof plan));
  assert.throws(() => requestCommand(state, testPlan(["recall_eva", "recall_eva"])), /duplicate/);
  state.scenario.availableActions = ["recall_eva"];
  assert.throws(() => requestCommand(state, testPlan(["shed_nonessential_load"])), /unavailable/);
});

test("proposal and approval preserve physical conditions; only observation executes commands", () => {
  const initial = createMission();
  const pending = requestCommand(initial, testPlan(["recall_eva"]));
  assert.deepEqual(pending.simulation, initial.simulation);
  const approved = approveCommand(pending, true);
  assert.equal(approved.outcome, undefined);
  assert.deepEqual(approved.simulation.conditions, initial.simulation.conditions);
  assert(approved.simulation.commands.every((command) => command.status === "pending"));
  const declined = approveCommand(pending, false);
  assert.deepEqual(declined.simulation, initial.simulation);
  assert.equal(advanceMission(declined).simulation.elapsedMinutes, 0);
  assert.throws(() => approveCommand(initial, true), /No command/);
});

test("different coolant response plans succeed with sufficient initial reserves", () => {
  const state = createMission("coolant_leak");
  state.simulation.conditions.batteryPct = 90;
  const lean = finish(dispatch(state, ["deploy_repair_drone"]));
  const conservative = finish(dispatch(state, ["deploy_repair_drone", "shed_nonessential_load"]));
  assert.equal(lean.outcome, "stabilized");
  assert.equal(conservative.outcome, "stabilized");
  assert(conservative.simulation.conditions.batteryPct > lean.simulation.conditions.batteryPct);
});

test("an ineffective but supported plan executes and fails on measured conditions", () => {
  const initial = createMission();
  const dispatched = dispatch(initial, ["verify_orbital_weather"]);
  assert.equal(dispatched.outcome, undefined);
  const result = observe(dispatched);
  assert.equal(result.outcome, "degraded");
  assert.equal(result.phase, "assessment");
  assert.equal(result.simulation.commands[0].status, "succeeded");
  assert(result.objectiveResults.some((goal) => !goal.met));
  assert.equal(result.minutesToImpact, initial.minutesToImpact - 12);
});

test("identical commands can succeed or fail depending on available reserves", () => {
  const healthy = createMission("coolant_leak");
  const depleted = structuredClone(healthy);
  depleted.simulation.conditions = initialConditions({
    ...depleted.simulation.conditions,
    batteryPct: 7,
  });
  assert.equal(
    finish(dispatch(healthy, ["deploy_repair_drone", "shed_nonessential_load"])).outcome,
    "stabilized"
  );
  const failed = observe(dispatch(depleted, ["deploy_repair_drone"]));
  assert.equal(failed.outcome, "failed");
  assert(failed.simulation.conditions.batteryPct < 20);
  assert.equal(failed.simulation.commands[0].status, "failed");
});

test("rover recovery waits for communications and is independent of command list order", () => {
  const waiting = advanceMission(
    dispatch(createMission("rover_recovery"), ["deploy_repair_drone"]),
    2
  );
  assert.equal(waiting.simulation.commands[0].status, "pending");
  const withoutLink = advanceMission(waiting, 1);
  assert.equal(withoutLink.simulation.conditions.roverMobilityPct, 0);
  assert.equal(withoutLink.phase, "assessment");
  assert.equal(withoutLink.replanning?.status, "queued");
  assert.match(withoutLink.replanning!.reason, /no progress/);
  for (const actions of [
    ["recall_eva", "deploy_repair_drone", "switch_to_backup_relay"],
    ["switch_to_backup_relay", "deploy_repair_drone", "recall_eva"],
  ] as MissionAction[][]) {
    const first = advanceMission(dispatch(createMission("rover_recovery"), actions));
    assert.equal(first.simulation.conditions.roverMobilityPct, 0);
    assert.equal(
      first.simulation.commands.find((command) => command.action === "deploy_repair_drone")!
        .progressMinutes,
      0
    );
    const rescued = finish(first);
    assert.equal(rescued.outcome, "stabilized");
    assert.equal(rescued.simulation.conditions.crewOutside, 0);
    assert.equal(rescued.simulation.conditions.distanceToSafetyKm, 0);
    assert.equal(rescued.simulation.elapsedMinutes, 27);
  }
});

test("a second approved response uses the changed world rather than resetting the incident", () => {
  const initial = createMission();
  initial.minutesToImpact = 40;
  const first = observe(dispatch(initial, ["recall_eva"]));
  assert.equal(first.outcome, "degraded");
  assert.equal(first.simulation.conditions.crewOutside, 0);
  const second = finish(dispatch(first, ["isolate_scrubber", "shed_nonessential_load"]));
  assert.equal(second.missionId, initial.missionId);
  assert.equal(second.simulation.elapsedMinutes, 40);
  assert.equal(second.simulation.history.length, 1);
  assert.equal(second.simulation.conditions.crewOutside, 0);
  assert.equal(second.outcome, "stabilized");
});

test("a missed response window stops execution before the crew can return", () => {
  const initial = createMission();
  initial.minutesToImpact = 2;
  const result = observe(
    dispatch(initial, ["recall_eva", "isolate_scrubber", "shed_nonessential_load"])
  );
  assert(result.simulation.conditions.crewOutside > 0);
  assert.equal(result.simulation.conditions.crewExposureMinutes, 0);
  assert.match(result.failureReason!, /window expired/);
  assert.equal(result.outcome, "failed");
  assert.deepEqual(advanceMission(result), result);
});

test("outcome targets, rather than command names, determine success", () => {
  const state = createMission("coolant_leak");
  const standard = finish(dispatch(state, ["deploy_repair_drone", "shed_nonessential_load"]));
  state.scenario.objectives.find((goal) => goal.metric === "batteryPct")!.target = 34;
  const stricter = finish(dispatch(state, ["deploy_repair_drone", "shed_nonessential_load"]));
  assert.equal(
    standard.simulation.conditions.coolantPct,
    stricter.simulation.conditions.coolantPct
  );
  assert.equal(standard.outcome, "stabilized");
  assert.equal(stricter.outcome, "failed");
  assert.deepEqual(
    stricter.objectiveResults,
    objectiveResults(stricter.simulation, state.scenario.objectives)
  );
});

test("all five seed incidents have feasible responses, with fresh state per mission", () => {
  const responses: Record<(typeof scenarioIds)[number], MissionAction[]> = {
    dust_storm: ["recall_eva", "isolate_scrubber", "shed_nonessential_load"],
    coolant_leak: ["deploy_repair_drone", "shed_nonessential_load"],
    relay_failure: ["recall_eva", "switch_to_backup_relay"],
    solar_flare: ["recall_eva", "switch_to_backup_relay", "shed_nonessential_load"],
    rover_recovery: ["switch_to_backup_relay", "deploy_repair_drone", "recall_eva"],
  };
  for (const id of scenarioIds) {
    const initial = createMission(id);
    const result = finish(dispatch(initial, responses[id]));
    assert.equal(result.outcome, "stabilized", id);
    assert(
      result.objectiveResults.every((goal) => goal.met),
      id
    );
    const fresh = createMission(id);
    assert.notEqual(fresh.missionId, initial.missionId);
    assert.equal(fresh.simulation.elapsedMinutes, 0);
    assert.deepEqual(fresh.simulation.conditions, initial.simulation.conditions);
  }
});

test("a return partway through a monitoring interval preserves exposure before arrival", () => {
  const initial = createMission();
  initial.minutesToImpact = 2;
  initial.simulation.conditions.crewReturnMinutes = 3;
  const result = stepSimulation(dispatch(initial, ["recall_eva"]).simulation, 2, 4);
  assert.equal(result.conditions.crewOutside, 0);
  assert(Math.abs(result.conditions.crewExposureMinutes - 1) < 1e-8);
});

test("long-running commands are monitored past three reports until completion", () => {
  const initial = createMission("solar_flare");
  initial.minutesToImpact = 40;
  initial.simulation.conditions.crewReturnMinutes = 20;
  initial.simulation.conditions.batteryPct = 100;
  initial.simulation.conditions.radiationFluxMsvPerMinute = 0;
  initial.simulation.conditions.radiationGrowthPerMinute = 0;
  let state = observe(
    dispatch(initial, ["recall_eva", "switch_to_backup_relay", "shed_nonessential_load"])
  );
  assert.equal(state.phase, "executing");
  for (let i = 0; i < 3; i++) state = advanceMission(state);
  assert.equal(state.phase, "executing");
  assert.equal(state.simulation.conditions.crewOutside, 0);
  state = finish(state);
  assert.equal(state.phase, "resolved");
  assert.equal(state.simulation.elapsedMinutes, 40);
});

test("reserve shortfall permits crew rescue but remains a failed acceptance target", () => {
  const initial = createMission("rover_recovery");
  initial.simulation.conditions = initialConditions({
    ...initial.simulation.conditions,
    batteryPct: 36.55,
  });
  let result = observe(
    dispatch(initial, [
      "recall_eva",
      "deploy_repair_drone",
      "switch_to_backup_relay",
      "shed_nonessential_load",
    ])
  );
  assert.equal(result.phase, "executing");
  assert(
    result.simulation.conditions.batteryPct > 0 && result.simulation.conditions.batteryPct < 20
  );
  result = advanceMission(result, 11);
  assert.equal(result.simulation.conditions.crewOutside, 0);
  assert.equal(result.simulation.conditions.distanceToSafetyKm, 0);
  result = finish(result);
  assert.equal(result.phase, "failed");
  assert.equal(result.simulation.elapsedMinutes, 27);
  assert.equal(result.simulation.conditions.crewExposureMinutes, 0);
  assert(result.objectiveResults.some((g) => !g.met && g.metric === "batteryPct"));
  assert.deepEqual(advanceMission(result), result);
});
