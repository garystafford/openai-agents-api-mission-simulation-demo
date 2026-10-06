import assert from "node:assert/strict";
import { test } from "node:test";
import { formatSimulationTime } from "../server/mission-contract.js";
import {
  advanceMission,
  approveCommand,
  createMission,
  requestCommand,
} from "../server/mission.js";
import {
  beginExecution,
  createSimulation,
  initialConditions,
  stepSimulation,
} from "../server/simulation.js";
import { testPlan } from "./fixtures.js";

test("mission time renders seconds, carries minutes and clamps negative values", () => {
  assert.equal(formatSimulationTime(18), "18:00");
  assert.equal(formatSimulationTime(637 / 60), "10:37");
  assert.equal(formatSimulationTime(0.001, true), "00:01");
  assert.equal(formatSimulationTime(157 / 60, true), "02:37");
  assert.equal(formatSimulationTime(-1), "00:00");
});

test("four-minute commands retain their duration at second precision and affect only subsequent consumption", () => {
  const c = initialConditions({
    essentialLoad: 0.4,
    nonessentialLoad: 1,
    solarCharge: 0,
    batteryPct: 60,
  });
  const initial = beginExecution(createSimulation(c), [
    "shed_nonessential_load",
    "switch_to_backup_relay",
    "verify_orbital_weather",
  ]);
  const before = stepSimulation(initial, 30, 239 / 60);
  assert(before.commands.every((command) => command.status === "running"));
  assert.equal(before.conditions.nonessentialLoad, 1);
  assert.equal(before.conditions.backupRelayOnline, 0);
  const completed = stepSimulation(before, 30 - 239 / 60, 1 / 60);
  assert(
    completed.commands.every(
      (command) => command.status === "succeeded" && command.progressMinutes === 4
    )
  );
  assert.equal(completed.conditions.nonessentialLoad, 0);
  assert.equal(completed.conditions.backupRelayOnline, 1);
  assert(Math.abs(completed.conditions.batteryPct - (60 - 1.4 * 4)) < 1e-8);
  const after = stepSimulation(completed, 26, 1);
  assert(Math.abs(after.conditions.batteryPct - (completed.conditions.batteryPct - 0.55)) < 1e-8);
});

test("drone work and physics are invariant across observer step sizes", () => {
  const initial = beginExecution(
    createSimulation(
      initialConditions({
        essentialLoad: 0,
        nonessentialLoad: 0,
        solarCharge: 0,
        batteryPct: 50,
        repairTarget: "coolant",
        coolantLeakRate: 0,
      })
    ),
    ["deploy_repair_drone"]
  );
  const large = stepSimulation(initial, 30, 8);
  let small = initial;
  for (let second = 0; second < 480; second++)
    small = stepSimulation(small, 30 - second / 60, 1 / 60);
  let playback = initial;
  for (let tick = 0; tick < 10; tick++) playback = stepSimulation(playback, 30 - tick * 0.8, 0.8);
  assert.deepEqual(large, small);
  assert.deepEqual(large, playback);
  assert.equal(large.commands[0].progressMinutes, 8);
  assert.equal(large.commands[0].status, "succeeded");
  assert(Math.abs(large.conditions.batteryPct - 38) < 1e-8);
});

test("crew return completes at the actual second while success waits through hazard arrival", () => {
  const initial = createMission();
  initial.simulation.conditions.crewReturnMinutes = 637 / 60;
  let state = approveCommand(
    requestCommand(initial, testPlan(["recall_eva", "isolate_scrubber", "shed_nonessential_load"])),
    true
  );
  while (state.phase === "executing") state = advanceMission(state, 0.8);
  assert.equal(state.phase, "resolved");
  assert.equal(state.simulation.elapsedMinutes, 18);
  assert.equal(
    state.simulation.commands.find((c) => c.action === "recall_eva")!.progressMinutes,
    637 / 60
  );
  assert.equal(state.minutesToImpact, 0);
  assert(state.timeline.some((entry) => entry.time === "T+10:37"));
  assert.equal(state.simulation.conditions.crewOutside, 0);
});

test("failure stops exactly at a seconds-based deadline without advancing to the next report", () => {
  const initial = createMission();
  initial.minutesToImpact = 137 / 60;
  const state = advanceMission(
    approveCommand(requestCommand(initial, testPlan(["recall_eva"])), true),
    4
  );
  assert.equal(state.phase, "failed");
  assert.equal(state.simulation.elapsedMinutes, 137 / 60);
  assert.equal(state.minutesToImpact, 0);
  assert(state.simulation.commands.every((command) => command.status === "failed"));
  assert.deepEqual(advanceMission(state), state);
});

test("cooling after repair continues while measured unmet goals improve", () => {
  let state = approveCommand(
    requestCommand(
      createMission("coolant_leak"),
      testPlan(["deploy_repair_drone", "shed_nonessential_load"])
    ),
    true
  );
  state = advanceMission(state, 12);
  assert.equal(state.phase, "executing");
  assert(state.simulation.commands.every((command) => command.status === "succeeded"));
  assert(state.objectiveResults.some((goal) => !goal.met));
  while (state.phase === "executing") state = advanceMission(state, 0.8);
  assert.equal(state.phase, "resolved");
  assert.equal(state.simulation.elapsedMinutes, 24);
  assert(state.objectiveResults.every((goal) => goal.met));
});

test("monitoring boundaries remain exact when a follow-up starts between minutes", () => {
  const initial = createMission();
  initial.simulation.elapsedMinutes = 4 / 60;
  const state = advanceMission(
    approveCommand(requestCommand(initial, testPlan(["recall_eva"])), true),
    4
  );
  assert.equal(state.phase, "executing");
  assert.equal(state.monitoringIntervals, 1);
  assert(
    state.timeline.some(
      (entry) => entry.time === "T+04:04" && entry.event.startsWith("Monitoring report")
    )
  );
});

test("a brief target crossing does not resolve an incident and stability resets on deterioration", () => {
  let state = approveCommand(
    requestCommand(
      createMission(),
      testPlan(["recall_eva", "isolate_scrubber", "shed_nonessential_load"])
    ),
    true
  );
  state = advanceMission(state, 11);
  assert.equal(state.phase, "executing");
  assert.equal(state.recoveryStableSinceMinutes, 11);
  state = advanceMission(state, 30 / 60);
  assert.equal(state.phase, "executing");
  state.simulation.conditions.carbonDioxidePpm = 2100;
  state = advanceMission(state, 1 / 60);
  assert.equal(state.recoveryStableSinceMinutes, undefined);
  while (state.phase === "executing") state = advanceMission(state, 0.8);
  assert.equal(state.phase, "resolved");
  assert(state.simulation.elapsedMinutes > 12);
});
