import { createMission } from "../../server/mission.js";
import { createSimulation, initialConditions, objectiveResults } from "../../server/simulation.js";
import { observeMissionTelemetry } from "../../server/telemetry.js";
import {
  directorInstructions,
  missionDirectorInput,
  specialistInstructions,
} from "../../server/agents.js";
import { missionRulesVersion } from "../../server/mission-rules.js";
import type { RecordedConsultation } from "../../server/agent-recording.js";
import type { ReviewedCase } from "./dataset.js";

import { arithmeticAgentTool } from "../../server/mission-arithmetic.js";

// A derived replay, never a claim that these updated inputs ran on the API.
// Preserve recorded numerical starting conditions rather than silently replacing
// historical reserves with the newly calibrated live-scenario defaults.
export function prepareReplay(record: RecordedConsultation): NonNullable<ReviewedCase["replay"]> {
  const state = createMission(record.state.scenario.id);
  state.missionId = record.state.missionId;
  state.timeline = structuredClone(record.state.timeline);
  state.minutesToImpact = record.state.minutesToImpact;
  state.scenario.minutesToImpact = state.minutesToImpact;
  state.scenario.initialConditions = initialConditions(record.state.simulation.conditions);
  state.simulation = createSimulation(state.scenario.initialConditions);
  state.telemetry = observeMissionTelemetry(
    state.simulation,
    state.scenario,
    state.minutesToImpact
  );
  state.objectiveResults = objectiveResults(state.simulation, state.scenario.objectives);
  const director = record.role === "Mission Director";
  return {
    rulesVersion: missionRulesVersion,
    provenance:
      "Derived offline from an actual consultation. Current instructions, rules, objectives and evidence; recorded initial numerical conditions. No new model response has been collected. Director reports are historical, imperfect fixtures and must be cross-checked.",
    state,
    agent: {
      ...record.agent,
      instructions: director ? directorInstructions() : specialistInstructions(record.role),
      ...(director
        ? {}
        : {
            tools: [
              ...(record.agent.tools ?? []).filter(
                (tool) => !("name" in tool) || tool.name !== arithmeticAgentTool.name
              ),
              arithmeticAgentTool,
            ],
          }),
    },
    input: director
      ? missionDirectorInput(state) +
        " Replay context: specialist replies are historical recorded fixtures. Check them against the current rules and observations supplied here."
      : "Historical consultation question (may contain outdated assumptions): " +
        record.input +
        "\nCurrent rules and evidence take precedence. Correct any false premise. Current incident context: " +
        missionDirectorInput(state),
  };
}
export function replayContext(item: ReviewedCase) {
  return item.replay ?? item.record;
}
