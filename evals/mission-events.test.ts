import assert from "node:assert/strict";
import { test } from "node:test";
import { missionEvent } from "../server/mission-events.js";
import { createMission, requestCommand, approveCommand } from "../server/mission.js";
import { testPlan } from "./fixtures.js";

test("events retain independent wall and simulation timestamps and immutable plan evidence", () => {
  const state = createMission();
  state.simulation.elapsedMinutes = 137 / 60;
  const plan = testPlan(["recall_eva"]);
  const event = missionEvent(
    state,
    { event: "Proposal", kind: "agent", plan },
    new Date("2026-10-04T12:00:00Z")
  );
  plan.actions.push("isolate_scrubber");
  assert.equal(event.time, "T+02:17");
  assert.equal(event.simulatedAtMinutes, 137 / 60);
  assert.equal(event.occurredAt, "2026-10-04T12:00:00.000Z");
  assert.deepEqual(event.plan?.actions, ["recall_eva"]);
  const approved = approveCommand(requestCommand(state, plan), true);
  assert(
    approved.timeline.every((entry) => entry.occurredAt && entry.simulatedAtMinutes !== undefined)
  );
  assert(
    approved.timeline.some((entry) => entry.kind === "approval" && entry.plan?.actions.length === 2)
  );
});
