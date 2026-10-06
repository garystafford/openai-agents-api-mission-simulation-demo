import assert from "node:assert/strict";
import { test } from "node:test";
import {
  recordAgentRun,
  withAgentRecording,
  type RecordedConsultation,
} from "../../server/agent-recording.js";
import { createMission } from "../../server/mission.js";
import type { FunctionCall, SessionRef } from "../../server/agents-api.js";

test("recorder is disabled outside its explicit context", async () => {
  const ref: SessionRef = { model: "gpt-6-luna", results: new Map() };
  const value = await recordAgentRun(
    "Life Support",
    ref,
    { model: ref.model },
    "input",
    async () => null,
    async () => ({ text: "answer" })
  );
  assert.equal(value.text, "answer");
});
test("concurrent mission recordings preserve their own state and actual tool results", async () => {
  const saved: RecordedConsultation[] = [];
  await Promise.all(
    ["dust_storm", "coolant_leak"].map(async (id) => {
      const state = createMission(id as "dust_storm" | "coolant_leak");
      const ref: SessionRef = { model: "gpt-6-luna", results: new Map() };
      await withAgentRecording(
        state,
        "director_selected",
        (record) => saved.push(record),
        () =>
          recordAgentRun(
            "Mission Director",
            ref,
            { model: ref.model },
            id,
            async () => null,
            async (handler) => {
              await Promise.resolve();
              ref.id = "session-" + id;
              ref.turnId = "turn-" + id;
              const call: FunctionCall = {
                type: "function_call",
                call_id: id,
                turn_id: ref.turnId,
                name: "submit_mission_plan",
                arguments: JSON.stringify({ headline: id }),
              };
              await handler(call);
              return { text: "", pending: call };
            }
          )
      );
    })
  );
  assert.equal(saved.length, 2);
  for (const record of saved) {
    assert.equal(record.input, record.state.scenario.id);
    assert.equal(JSON.parse(record.output).headline, record.state.scenario.id);
    assert.equal(record.tools[0].result, null);
    assert.equal(record.continuing, false);
  }
});
test("failed consultations are retained and errors still propagate", async () => {
  const saved: RecordedConsultation[] = [];
  await assert.rejects(
    withAgentRecording(
      createMission(),
      "coverage_supplement",
      (r) => saved.push(r),
      () =>
        recordAgentRun(
          "Risk Review",
          { model: "gpt-6-luna", results: new Map() },
          { model: "gpt-6-luna" },
          "question",
          async () => null,
          async () => {
            throw new Error("fixture error");
          }
        )
    ),
    /fixture error/
  );
  assert.equal(saved[0].error, "fixture error");
});
