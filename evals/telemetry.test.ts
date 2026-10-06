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
import { stepSimulation } from "../server/simulation.js";
import { observeMissionTelemetry } from "../server/telemetry.js";

const start = (state: MissionState, actions: MissionAction[]) =>
  approveCommand(requestCommand(state, testPlan(actions)), true);
const finish = (state: MissionState) =>
  [1, 2, 3].reduce((current) => advanceMission(current), state);
const reading = (state: MissionState, label: string) => {
  const result = state.telemetry.find((entry) => entry.label === label);
  assert(result, label);
  return result;
};

test("every incident exposes its diagnostic readings, units, baseline time and initial history", () => {
  const expected = {
    dust_storm: ["Cabin oxygen", "Cabin carbon dioxide", "Cabin pressure"],
    coolant_leak: ["Coolant flow", "Coolant leak rate", "Equipment temperature"],
    relay_failure: ["Relay signal strength", "Relay packet loss", "Backup relay draw"],
    solar_flare: ["Radiation flux", "Accumulated crew dose", "Radiation shelter"],
    rover_recovery: ["Rover wheel slip", "Rover motor current", "Distance to safety"],
  };
  for (const id of scenarioIds) {
    const state = createMission(id);
    assert.equal(new Set(state.telemetry.map((item) => item.label)).size, state.telemetry.length);
    for (const label of expected[id]) {
      const item = reading(state, label);
      assert.equal(typeof item.numericValue, "number");
      assert(item.unit);
    }
    for (const item of state.telemetry) {
      assert.equal(item.sampledAtMinutes, 0);
      assert.equal(item.trend, "insufficient_data");
      assert.deepEqual(item.history, [
        {
          elapsedMinutes: 0,
          value: item.value,
          ...(item.numericValue === undefined ? {} : { numericValue: item.numericValue }),
        },
      ]);
    }
  }
});

test("air diagnostics deteriorate with a scrubber fault and recover after isolation", () => {
  const initial = createMission();
  const first = advanceMission(start(initial, ["isolate_scrubber"]));
  assert.equal(reading(first, "Cabin oxygen").trend, "falling");
  assert.equal(reading(first, "Cabin carbon dioxide").trend, "rising");
  assert.equal(reading(first, "Cabin pressure").trend, "falling");
  const atCompletion = advanceMission(first);
  const second = advanceMission(atCompletion, 1);
  assert.equal(reading(second, "Cabin oxygen").trend, "rising");
  assert.equal(reading(second, "Cabin carbon dioxide").trend, "falling");
  assert.equal(reading(second, "Cabin pressure").trend, "rising");
  assert.equal(reading(second, "Cabin carbon dioxide").history?.length, 4);
  assert.equal(initial.simulation.elapsedMinutes, 0);
});

test("coolant repair changes leak, circulation and equipment temperature measurements", () => {
  const initial = createMission("coolant_leak");
  const first = advanceMission(start(initial, ["deploy_repair_drone"]));
  assert.equal(reading(first, "Coolant flow").trend, "falling");
  assert.equal(reading(first, "Equipment temperature").trend, "rising");
  const second = advanceMission(first);
  assert.equal(reading(second, "Coolant leak rate").numericValue, 0);
  assert.equal(reading(second, "Coolant flow").trend, "rising");
  assert.equal(reading(advanceMission(second, 1), "Equipment temperature").trend, "falling");
});

test("restored relay improves link diagnostics while its added drain is charged to reserves", () => {
  const initial = createMission("relay_failure");
  const next = advanceMission(start(initial, ["switch_to_backup_relay"]));
  assert.equal(reading(next, "Relay signal strength").trend, "rising");
  assert.equal(reading(next, "Relay packet loss").numericValue, 0);
  assert.equal(reading(next, "Backup relay draw").numericValue, 0.15);
  const noRelay = advanceMission(start(initial, ["verify_orbital_weather"]));
  assert.equal(next.simulation.conditions.batteryPct, noRelay.simulation.conditions.batteryPct);
  assert(
    stepSimulation(next.simulation, next.minutesToImpact).conditions.batteryPct <
      stepSimulation(noRelay.simulation, noRelay.minutesToImpact).conditions.batteryPct
  );
});

test("shelter reduces dose accumulation while external radiation keeps rising and prior dose persists", () => {
  const initial = createMission("solar_flare");
  initial.simulation.conditions.crewReturnMinutes = 3;
  const sheltered = advanceMission(start(initial, ["recall_eva"]));
  const outside = advanceMission(start(initial, ["verify_orbital_weather"]));
  assert.equal(reading(sheltered, "Radiation flux").trend, "rising");
  assert.equal(reading(sheltered, "Radiation shelter").numericValue, 98);
  assert(sheltered.simulation.conditions.crewDoseMsv > 0);
  assert(sheltered.simulation.conditions.crewDoseMsv < outside.simulation.conditions.crewDoseMsv);
  const later = advanceMission(sheltered);
  assert(later.simulation.conditions.crewDoseMsv > sheltered.simulation.conditions.crewDoseMsv);
  assert.equal(reading(later, "Accumulated crew dose").trend, "rising");
});

test("rover repair changes slip and motor current and enables progress toward safety", () => {
  const initial = createMission("rover_recovery");
  const blocked = finish(start(initial, ["deploy_repair_drone"]));
  assert.equal(reading(blocked, "Rover wheel slip").numericValue, 100);
  assert.equal(reading(blocked, "Rover motor current").numericValue, 32);
  assert.equal(reading(blocked, "Distance to safety").numericValue, 5);
  const recovered = advanceMission(
    start(initial, ["recall_eva", "deploy_repair_drone", "switch_to_backup_relay"]),
    16
  );
  assert.equal(reading(recovered, "Rover wheel slip").numericValue, 15);
  assert.equal(reading(recovered, "Rover motor current").numericValue, 12);
  assert(reading(recovered, "Distance to safety").numericValue! < 5);
  assert(
    Math.abs(
      reading(recovered, "Distance to safety").numericValue! -
        Math.round(((5 * 7) / 11) * 1000) / 1000
    ) < 1e-8
  );
  assert.equal(reading(recovered, "Distance to safety").trend, "falling");
});

test("history is bounded, retained across responses, and starts clean for a new mission", () => {
  const initial = createMission();
  initial.minutesToImpact = 40;
  const first = finish(start(initial, ["recall_eva"]));
  const second = finish(start(first, ["isolate_scrubber", "shed_nonessential_load"]));
  const history = reading(second, "Cabin oxygen").history!;
  assert.deepEqual(
    history.map((sample) => sample.elapsedMinutes),
    [4, 8, 12, 16, 20, 24]
  );
  const refreshed = observeMissionTelemetry(
    second.simulation,
    second.scenario,
    second.minutesToImpact,
    second.telemetry
  );
  assert.deepEqual(refreshed.find((item) => item.label === "Cabin oxygen")!.history, history);
  assert.equal(reading(createMission(), "Cabin oxygen").history!.length, 1);
  assert.equal(reading(first, "Cabin oxygen").history!.length, 4);
});

test("restoring equipment alone cannot hide hazardous diagnostic conditions", () => {
  const initial = createMission();
  initial.simulation.conditions.carbonDioxidePpm = 20000;
  const result = finish(
    start(initial, ["recall_eva", "isolate_scrubber", "shed_nonessential_load"])
  );
  assert.equal(result.simulation.conditions.airProcessingPct, 95);
  assert.equal(result.phase, "executing");
  let expired = result;
  while (expired.phase === "executing") expired = advanceMission(expired);
  assert.equal(expired.outcome, "failed");
  assert.equal(
    result.objectiveResults.find((goal) => goal.metric === "carbonDioxidePpm")!.met,
    false
  );
});
