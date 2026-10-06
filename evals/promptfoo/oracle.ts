import {
  beginExecution,
  objectiveResults,
  stepSimulation,
  type ObjectiveResult,
} from "../../server/simulation.js";
import { hardSafetyFailure } from "../../server/mission-rules.js";
import {
  recoveryConfirmationSeconds,
  type MissionAction,
  type MissionState,
} from "../../server/mission-contract.js";

// All plans are compared at the same original hazard deadline. No new command
// or implicit replan is introduced when the live UI would request reassessment.
export function evaluateActionSet(state: MissionState, actions: MissionAction[]) {
  let simulation = beginExecution(state.simulation, actions);
  let stableSeconds = 0;
  let hardFailure: string | undefined;
  let goals = objectiveResults(simulation, state.scenario.objectives);
  const seconds = Math.round(state.minutesToImpact * 60);
  for (let second = 0; second < seconds; second++) {
    const remaining = (seconds - second) / 60;
    const priorCompliant =
      !simulation.commands.some((c) => c.status === "pending" || c.status === "running") &&
      goals.every((g) => g.met);
    simulation = stepSimulation(simulation, remaining, 1 / 60);
    goals = objectiveResults(simulation, state.scenario.objectives);
    hardFailure ??= hardSafetyFailure(simulation.conditions, goals);
    if (hardFailure)
      for (const command of simulation.commands) {
        if (command.status === "running" || command.status === "pending") {
          command.status = "failed";
          command.detail = "Stopped at a hard physical/crew safety boundary.";
        }
      }
    const compliant =
      !hardFailure &&
      !simulation.commands.some((c) => c.status !== "succeeded") &&
      goals.every((g) => g.met);
    stableSeconds = priorCompliant && compliant ? stableSeconds + 1 : 0;
  }
  const rank = mitigationRank(goals);
  return {
    actions,
    phase: !hardFailure && stableSeconds >= recoveryConfirmationSeconds ? "resolved" : "failed",
    horizonMinutes: state.simulation.elapsedMinutes + state.minutesToImpact,
    elapsedMinutes: simulation.elapsedMinutes,
    unmet: goals.filter((g) => !g.met).map((g) => g.label),
    goals,
    conditions: simulation.conditions,
    hardFailure,
    rank,
  };
}

// Declared lexicographic policy: irreversible crew harm, crew arrival, life
// support/thermal capability, other operational capability, then power margins.
// Normalize deficits so unrelated units do not receive arbitrary raw weights.
export function mitigationRank(goals: ObjectiveResult[]): number[] {
  const rank = [0, 0, 0, 0, 0];
  for (const goal of goals) {
    const deficit =
      Math.max(
        0,
        goal.comparison === "at_least" ? goal.target - goal.actual : goal.actual - goal.target
      ) / Math.max(1, Math.abs(goal.target));
    const group = ["crewExposureMinutes", "crewDoseMsv"].includes(goal.metric)
      ? 0
      : ["crewOutside", "distanceToSafetyKm"].includes(goal.metric)
        ? 1
        : [
              "oxygenPct",
              "carbonDioxidePpm",
              "cabinPressureKpa",
              "airProcessingPct",
              "coolantPct",
              "coolantFlowLMin",
              "equipmentTemperatureC",
              "cabinTemperatureC",
              "shelterProtectionPct",
            ].includes(goal.metric)
          ? 2
          : ["batteryPct", "powerEnduranceMinutes"].includes(goal.metric)
            ? 4
            : 3;
    rank[group] += deficit;
  }
  return rank;
}
export function compareRanks(a: number[], b: number[]) {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-7) return a[i] - b[i];
  return 0;
}
export function actionOracle(state: MissionState) {
  const actions = state.scenario.availableActions;
  const outcomes: ReturnType<typeof evaluateActionSet>[] = [];
  for (let mask = 1; mask < 2 ** actions.length; mask++) {
    const selected = actions.filter((_action, i) => mask & (1 << i));
    if (selected.length <= 4) outcomes.push(evaluateActionSet(state, selected));
  }
  const successful = outcomes.filter((o) => o.phase === "resolved");
  const bestRank = outcomes.reduce(
    (best, o) => (compareRanks(o.rank, best) < 0 ? o.rank : best),
    outcomes[0].rank
  );
  const best = successful.length
    ? successful
    : outcomes.filter((o) => compareRanks(o.rank, bestRank) === 0);
  return {
    feasible: successful.length > 0,
    policy:
      "common-hazard-deadline; lexicographic crew harm, crew arrival, life support/thermal, other capability, power",
    acceptable: best.map((o) => o.actions),
    bestRank,
    // Diagnostic only; this count never selects the accepted mitigation.
    minimumUnmet: Math.min(...outcomes.map((o) => o.unmet.length)),
    bestAchievableUnmet: best[0].unmet.length,
    outcomes,
  };
}
export function successfulActionSets(state: MissionState) {
  const oracle = actionOracle(state);
  return oracle.feasible ? oracle.acceptable : [];
}
