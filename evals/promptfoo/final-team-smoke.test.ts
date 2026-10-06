import assert from "node:assert/strict";
import test from "node:test";
import { validationInputs } from "./validation-inputs.js";

test("final-team smoke covers each family once with states distinct from prior validation", () => {
  const prior = new Set(validationInputs().map((item) => item.conditionsSha256));
  const inputs = validationInputs("final-team-smoke-2026-10-05-v1", 1);
  assert.equal(inputs.length, 5);
  assert.equal(new Set(inputs.map(({ state }) => state.scenario.id)).size, 5);
  assert.equal(new Set(inputs.map(({ state }) => state.missionId)).size, 5);
  for (const input of inputs) {
    assert.equal(input.repeat, 1);
    assert(!prior.has(input.conditionsSha256));
  }
  const again = validationInputs("final-team-smoke-2026-10-05-v1", 1);
  assert.deepEqual(
    inputs.map((i) => i.conditionsSha256),
    again.map((i) => i.conditionsSha256)
  );
  assert.notEqual(inputs[0].state.missionId, again[0].state.missionId);
});
