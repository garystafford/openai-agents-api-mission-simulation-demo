import assert from "node:assert/strict";
import { test } from "node:test";
import { createMission } from "../../server/mission.js";
import {
  missionEvidence,
  telemetryForSystem,
  connectMissionMcp,
} from "../../server/mission-evidence.js";
import { validationRubric } from "./validation-cases.js";
import { loadCase, loadManifest } from "./dataset.js";

test("named power telemetry includes all calculation inputs across all five incidents", () => {
  for (const scenario of [
    "dust_storm",
    "coolant_leak",
    "relay_failure",
    "solar_flare",
    "rover_recovery",
  ] as const) {
    const context = missionEvidence(createMission(scenario));
    const readings = telemetryForSystem(context, "power");
    for (const metric of [
      "batteryPct",
      "essentialLoad",
      "nonessentialLoad",
      "solarCharge",
      "powerEnduranceMinutes",
    ])
      assert(
        readings.some((reading) => reading.metric === metric),
        scenario + ":" + metric
      );
    assert.deepEqual(telemetryForSystem(context, " ELECTRICAL "), readings);
    assert.deepEqual(telemetryForSystem(context, "all"), context.telemetry);
    assert.deepEqual(telemetryForSystem(context, "unknown-system"), context.telemetry);
  }
});

test("production MCP power query actually returns electrical rates without advancing simulation", async () => {
  const state = createMission("relay_failure");
  const before = JSON.stringify(state);
  const client = await connectMissionMcp(state);
  try {
    const result = await client.callTool({
      name: "mcp_read_mission_telemetry",
      arguments: { system: "power" },
    });
    const content = result.content as { type: string; text: string }[];
    const value = JSON.parse(content.find((row) => row.type === "text")!.text);
    for (const metric of [
      "essentialLoad",
      "nonessentialLoad",
      "solarCharge",
      "backupRelayDrawPctPerMinute",
    ])
      assert(value.readings.some((reading: { metric: string }) => reading.metric === metric));
    assert.equal(JSON.stringify(state), before);
  } finally {
    await client.close();
  }
});

test("fresh rubric distinguishes actual received evidence from broader retrievable facts", () => {
  const record = structuredClone(loadCase(loadManifest().cases[0].id).record);
  record.input = "ACTUAL_QUESTION";
  record.output = "CURRENT_ANSWER_NOT_EVIDENCE";
  const rubric = validationRubric(record, []);
  assert(rubric.includes("RECEIVED evidence"));
  assert(rubric.includes("RETRIEVABLE public mission facts (not proof"));
  assert(rubric.includes("ACTUAL_QUESTION"));
  assert(!rubric.includes(record.output));
  assert(rubric.includes("NEEDS_REVIEW"));
});
