import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMission,
  requestCommand,
  approveCommand,
  advanceMission,
} from "../server/mission.js";
import { stepSimulation, beginExecution } from "../server/simulation.js";
import { observeMissionTelemetry } from "../server/telemetry.js";
import { missionEvidence } from "../server/mission-evidence.js";
import { testPlan } from "./fixtures.js";

test("recorded seeds reproduce initial conditions; different seeds vary them", () => {
  const a = createMission("rover_recovery", { seed: "repeatable", profile: "varied" });
  const b = createMission("rover_recovery", { seed: "repeatable", profile: "varied" });
  const c = createMission("rover_recovery", { seed: "different", profile: "varied" });
  assert.deepEqual(a.simulation, b.simulation);
  assert.notDeepEqual(a.simulation.conditions, c.simulation.conditions);
});
test("repair interruption is deterministic, consumes only actual work, and allows an authorized retry", () => {
  const state = createMission("coolant_leak", { seed: "repair", profile: "repair_failure" });
  let sim = beginExecution(state.simulation, ["deploy_repair_drone", "shed_nonessential_load"]);
  sim = stepSimulation(sim, state.minutesToImpact, 1);
  assert.equal(sim.commands[0].status, "failed");
  assert.equal(sim.commands[0].progressMinutes, 59 / 60);
  const retried = stepSimulation(
    beginExecution(sim, ["deploy_repair_drone"]),
    state.minutesToImpact - 1,
    8
  );
  assert.equal(retried.commands[0].status, "succeeded");
  assert.equal(retried.conditions.coolantLeakRate, 0);
});
test("communications outage interrupts link-dependent work and later restores the link", () => {
  const state = createMission("rover_recovery", { seed: "link", profile: "communications_outage" });
  let sim = beginExecution(state.simulation, ["switch_to_backup_relay", "deploy_repair_drone"]);
  sim = stepSimulation(sim, state.minutesToImpact, 5);
  assert.equal(sim.conditions.communicationsPct, 0);
  const progress = sim.commands[1].progressMinutes;
  sim = stepSimulation(sim, state.minutesToImpact - 5, 1);
  assert.equal(sim.commands[1].progressMinutes, progress);
  sim = stepSimulation(sim, state.minutesToImpact - 6, 1);
  assert.equal(sim.conditions.communicationsPct, 100);
  assert(sim.commands[1].progressMinutes > progress);
});
test("delayed observations preserve sample times and do not reveal future values in history", () => {
  let state = createMission("coolant_leak", { seed: "delay", profile: "delayed_sensors" });
  state = approveCommand(requestCommand(state, testPlan(["deploy_repair_drone"])), true);
  for (let i = 0; i < 4; i++) state = advanceMission(state, 0.8);
  const readings = observeMissionTelemetry(
    state.simulation,
    state.scenario,
    state.minutesToImpact,
    state.telemetry
  );
  assert(readings.every((reading) => reading.quality === "delayed"));
  assert(readings.every((reading) => reading.sampledAtMinutes! <= 1.6));
  assert(
    readings.every((reading) =>
      reading.history!.every((sample) => sample.elapsedMinutes <= reading.sampledAtMinutes!)
    )
  );
  assert(!JSON.stringify(missionEvidence(state)).includes("sensorSnapshots"));
});
test("combined incidents add observable air-processing goals and supported recovery capabilities", () => {
  const state = createMission("coolant_leak", { seed: "combined", profile: "compound" });
  assert(state.scenario.availableActions.includes("isolate_scrubber"));
  assert(state.scenario.objectives.some((goal) => goal.metric === "airProcessingPct"));
  assert(missionEvidence(state).objectives.every((goal) => goal.observed !== null));
});
