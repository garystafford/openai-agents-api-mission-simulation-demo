import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMission,
  requestCommand,
  approveCommand,
  advanceMission,
  scenarioIds,
} from "../server/mission.js";
import { missionEvidence, verificationReport } from "../server/mission-evidence.js";
import { testPlan } from "./fixtures.js";

test("the model evidence boundary exposes observed targets and capabilities without private fault state", () => {
  for (const id of scenarioIds) {
    const state = createMission(id);
    const context = missionEvidence(state);
    const serialized = JSON.stringify(context);
    for (const hidden of [
      "repairTarget",
      "scrubberFault",
      "radiationGrowthPerMinute",
      "initialConditions",
      "conditions",
      "verification",
    ])
      assert(!serialized.includes('"' + hidden + '"'), hidden);
    assert(
      context.objectives.every((goal) => goal.observed !== null),
      id
    );
    assert(context.telemetry.some((reading) => reading.metric === "essentialLoad"));
  }
});

test("verification follows current observed repair results rather than the original incident narrative", () => {
  const initial = createMission("coolant_leak");
  const before = verificationReport(missionEvidence(initial), "maintenance");
  const repaired = advanceMission(
    approveCommand(
      requestCommand(initial, testPlan(["deploy_repair_drone", "shed_nonessential_load"])),
      true
    ),
    8
  );
  const after = verificationReport(missionEvidence(repaired), "maintenance");
  assert.equal(
    before.readings.find((reading) => reading.metric === "coolantLeakRate")?.numericValue,
    4
  );
  assert.equal(
    after.readings.find((reading) => reading.metric === "coolantLeakRate")?.numericValue,
    0
  );
  assert.equal(after.verifiedAtMinutes, 8);
  assert.equal(
    after.execution.find((command) => command.action === "deploy_repair_drone")?.status,
    "succeeded"
  );
});

test("public evidence states the absolute confirmation interval and incident-specific recall gates", () => {
  for (const id of scenarioIds) {
    const state = createMission(id);
    const evidence = missionEvidence(state);
    assert.equal(evidence.responseWindow.confirmationEndMinutes, state.minutesToImpact);
    assert.equal(evidence.responseWindow.confirmationStartMinutes, state.minutesToImpact - 1);
    assert.equal(evidence.responseWindow.postDeadlineConfirmationRequired, false);
    assert.equal(
      evidence.recallPrerequisites.communicationsAtLeastPct,
      id === "rover_recovery" ? 80 : 0
    );
    assert.equal(evidence.authorization.maximumActionsPerProposal, 4);
    assert.equal(evidence.authorization.authority, "commander");
    assert.equal(evidence.recallPrerequisites.explicitInitialRecallRequired, true);
    const later = missionEvidence(
      advanceMission(
        approveCommand(requestCommand(state, testPlan([state.scenario.availableActions[0]])), true),
        1
      )
    );
    assert.equal(
      later.responseWindow.hazardDeadlineMinutes,
      evidence.responseWindow.hazardDeadlineMinutes
    );
  }
});

test("relay recall moves immediately without the rover-rescue communications gate", () => {
  const state = createMission("relay_failure");
  assert(state.simulation.conditions.communicationsPct < 80);
  const next = advanceMission(
    approveCommand(requestCommand(state, testPlan(["recall_eva"])), true),
    1
  );
  assert(
    next.simulation.conditions.crewReturnMinutes < state.simulation.conditions.crewReturnMinutes
  );
  const rover = createMission("rover_recovery");
  const waiting = advanceMission(
    approveCommand(requestCommand(rover, testPlan(["recall_eva"])), true),
    1
  );
  assert.equal(
    waiting.simulation.conditions.crewReturnMinutes,
    rover.simulation.conditions.crewReturnMinutes
  );
});
