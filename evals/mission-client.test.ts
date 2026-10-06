import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAssessmentEvent,
  displaySpecialistNames,
  readAssessmentEvents,
} from "../src/mission-client.js";
import { createMission } from "../server/mission.js";
import type { AssessmentEvent, MissionResponse } from "../server/mission-contract.js";
import { testPlan } from "./fixtures.js";

test("saved call signs display as roles without modifying original plans or audit text", () => {
  const saved = {
    ...createMission(),
    missionId: "mission-NOVA",
    variation: { seed: "KEPLER", profile: "baseline" },
    agentProfiles: { NOVA: { model: "custom-model", reasoningEffort: "high" } },
    councilLog: [{ id: "old", speaker: "KEPLER", kind: "api", message: "Asked NOVA and AURA." }],
    selectedPlan: { ...testPlan(["recall_eva"]), rationale: "MERCURY reviewed the plan." },
  };
  const original = structuredClone(saved);
  const displayed = displaySpecialistNames(saved);
  assert.equal(displayed.councilLog[0].speaker, "Weather & Navigation");
  assert.equal(displayed.councilLog[0].message, "Asked Power & Thermal and Life Support.");
  assert.equal(displayed.selectedPlan.rationale, "Risk Review reviewed the plan.");
  assert.equal(displayed.missionId, "mission-NOVA");
  assert.equal(displayed.variation.seed, "KEPLER");
  assert.deepEqual(displaySpecialistNames({ constructor: "unchanged" }), {
    constructor: "unchanged",
  });
  assert.deepEqual(Object.keys(displayed.agentProfiles), ["Power & Thermal"]);
  assert.deepEqual(saved, original);
  assert.equal(displaySpecialistNames(displayed), displayed);
  const streamed = applyAssessmentEvent(
    { ...createMission(), agentProfiles: {} },
    {
      type: "activity",
      entry: { id: "old", speaker: "NOVA", kind: "api", message: "Consulted MERCURY." },
    }
  );
  assert.equal(streamed.councilLog[0].speaker, "Power & Thermal");
  assert.equal(streamed.councilLog[0].message, "Consulted Risk Review.");
});

test("assessment stream handles split UTF-8, CRLF frames, comments and a final unframed event", async () => {
  const event: AssessmentEvent = {
    type: "activity",
    entry: {
      id: "one",
      speaker: "Power & Thermal",
      kind: "assessment",
      message: "Crew’s power reserve",
    },
  };
  const bytes = new TextEncoder().encode(
    ": keepalive\r\n\r\ndata: " + JSON.stringify(event) + "\r\n\r\ndata: " + JSON.stringify(event)
  );
  let offset = 0;
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.slice(offset, ++offset));
      },
    })
  );
  const received: AssessmentEvent[] = [];
  await readAssessmentEvents(response, (value) => received.push(value));
  assert.deepEqual(received, [event, event]);
  assert.equal(response.body!.locked, false);
});

test("stream observer failure cancels and unlocks its reader", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"error","message":"Budget reached"}\n\n')
        );
      },
      cancel() {
        cancelled = true;
      },
    })
  );
  await assert.rejects(
    readAssessmentEvents(response, (event) => {
      if (event.type === "error") throw new Error(event.message);
    }),
    /Budget reached/
  );
  assert.equal(cancelled, true);
  assert.equal(response.body!.locked, false);
});

test("failed assessment requests retain the server's actionable validation error", async () => {
  await assert.rejects(
    readAssessmentEvents(
      new Response(JSON.stringify({ error: "Review request must contain 1–4000 characters." }), {
        status: 400,
      }),
      () => {}
    ),
    /1–4000/
  );
});

test("repeated streamed events cannot duplicate activity or specialist reports", () => {
  const original: MissionResponse = { ...createMission(), agentProfiles: {} };
  const activity: AssessmentEvent = {
    type: "activity",
    entry: { id: "one", speaker: "Power & Thermal", kind: "api", message: "Consulting" },
  };
  const report: AssessmentEvent = {
    type: "report",
    report: {
      agent: "Power & Thermal",
      role: "Power",
      status: "watch",
      confidence: 0.8,
      recommendation: "Review power",
      evidence: ["Battery"],
      tradeoff: "Reserve",
    },
  };
  let current = applyAssessmentEvent(applyAssessmentEvent(original, activity), activity);
  current = applyAssessmentEvent(applyAssessmentEvent(current, report), {
    ...report,
    report: { ...report.report, recommendation: "Updated advice" },
  });
  assert.equal(current.councilLog.length, 1);
  assert.equal(current.reports.length, 1);
  assert.equal(current.reports[0].recommendation, "Updated advice");
  assert.equal(original.councilLog.length, 0);
  assert.equal(original.reports.length, 0);
});

test("completion replaces provisional progress with the authoritative approval snapshot", () => {
  const mission: MissionResponse = { ...createMission(), agentProfiles: {} };
  const plan = testPlan(["recall_eva"]);
  const completed: MissionResponse = {
    ...mission,
    selectedPlan: plan,
    proposalId: "proposal",
    operation: { kind: "assessment", status: "complete", startedAt: 1 },
  };
  assert.equal(
    applyAssessmentEvent(mission, { type: "complete", plan, state: completed }),
    completed
  );
});
