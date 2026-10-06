import { createMission, scenarioIds } from "../../server/mission.js";
import { loadCase, loadManifest } from "./dataset.js";
import { sha256 } from "./saved-comparison.js";

export const validationSeed = "heldout-2026-10-04-model-selection-v1";
export function validationInputs(seed = validationSeed, repeats = 2) {
  const trainingConditions = new Set(
    loadManifest().cases.map(({ id }) => {
      const item = loadCase(id);
      return sha256(
        JSON.stringify((item.replay?.state ?? item.record.state).simulation.conditions)
      );
    })
  );
  return scenarioIds.flatMap((scenario) =>
    Array.from({ length: repeats }, (_, index) => index + 1).map((repeat) => {
      const state = createMission(scenario, {
        profile: "varied",
        seed: seed + ":" + scenario,
      });
      const conditionsSha256 = sha256(JSON.stringify(state.simulation.conditions));
      if (trainingConditions.has(conditionsSha256))
        throw new Error("Validation state overlaps selection dataset");
      return { state, repeat, conditionsSha256 };
    })
  );
}
