import assert from "node:assert/strict";
import { test } from "node:test";
import { checkArithmetic, arithmeticValidationFeedback } from "../../server/mission-arithmetic.js";
import { createMission } from "../../server/mission.js";
import { connectMissionMcp } from "../../server/mission-evidence.js";
import { gradeEpisode } from "./assertions.js";
import { loadCase, loadManifest } from "./dataset.js";

const calculations = [
  { label: "relay no-shed projection", terms: [[48], [-4, 0.4], [-27, 0.55]] },
  { label: "solar conditional projection", terms: [[56.1], [-4, 1.6], [-11, 1.75]] },
  { label: "endurance minutes", terms: [[30]], divisor: 0.5 },
];
test("arithmetic checks the two observed mistakes and division without inventing mission assumptions", () => {
  assert.deepEqual(
    checkArithmetic({ calculations }).calculations.map((c) => c.result),
    [31.55, 30.45, 60]
  );
  assert.throws(() =>
    checkArithmetic({ calculations: [{ label: "zero", terms: [[1]], divisor: 0 }] })
  );
  assert.throws(() =>
    checkArithmetic({ calculations: [{ label: "code", terms: [["process.exit()"]] }] })
  );
  assert.throws(() =>
    checkArithmetic({ calculations: [{ label: "overflow", terms: [[Infinity]] }] })
  );
});
test("MCP calculator is callable and leaves mission state unchanged", async () => {
  const state = createMission("relay_failure");
  const before = structuredClone(state);
  const mcp = await connectMissionMcp(state);
  try {
    const result = await mcp.callTool({
      name: "mcp_check_arithmetic",
      arguments: { calculations },
    });
    assert.ok(!result.isError);
    const block = (result as { content?: Array<{ type: string; text?: string }> }).content?.find(
      (entry) => entry.type === "text"
    );
    assert.ok(block && "text" in block);
    assert.equal(JSON.parse(block.text as string).calculations[0].result, 31.55);
    assert.deepEqual(state, before);
  } finally {
    await mcp.close();
  }
});
test("calculator calls do not substitute for a required evidence read", () => {
  const item = loadCase(loadManifest().cases.find((entry) => entry.role === "Life Support")!.id);
  const answer = JSON.parse(item.record.output);
  assert.equal(
    gradeEpisode(
      JSON.stringify({
        answer,
        tools: [{ name: "mcp_check_arithmetic", arguments: { calculations }, success: true }],
      }),
      item
    ).pass,
    false
  );
});

test("calculator errors expose exact bounds and respect the remaining call budget", () => {
  const invalid = { calculations: [{ label: "x".repeat(101), terms: [[1]] }] };
  assert.match(
    arithmeticValidationFeedback("mcp_check_arithmetic", invalid, 2)!,
    /calculations.0.label.*100/
  );
  assert.match(
    arithmeticValidationFeedback("mcp_check_arithmetic", invalid, 2)!,
    /remaining 2 tool calls/
  );
  const last = arithmeticValidationFeedback("mcp_check_arithmetic", invalid, 4)!;
  assert.match(last, /No tool calls remain/);
  assert(!/retry|Correct the arguments/.test(last));
  assert(!last.includes("x".repeat(101)));
  assert.equal(
    arithmeticValidationFeedback("mcp_check_arithmetic", { calculations }, 1),
    undefined
  );
  assert.equal(arithmeticValidationFeedback("mcp_read_mission_telemetry", {}, 1), undefined);
});
