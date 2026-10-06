import { variationProfiles } from "../server/incident-variation.js";
import { createMission, scenarioIds, type MissionState } from "../server/mission.js";
import { initialConditions, objectiveResults } from "../server/simulation.js";
import { observeMissionTelemetry } from "../server/telemetry.js";
export type BenchmarkRow = {
  expectedFeasibility?: "feasible" | "infeasible_single_proposal";
  initialConditions?: MissionState["simulation"]["conditions"];
  scenario: string;
  variant: string;
  repeat: number;
  status: "resolved" | "unresolved" | "failed" | "error";
  approvalReadyMs?: number;
  elapsedMs: number;
  consultations: number;
  validationRetries: number;
  estimatedCostUsd?: number;
  accountingPending?: boolean;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  knownEstimatedCostUsd?: number;
  unmet: string[];
  error?: string;
  actions?: string[];
  seed?: string;
  replans?: number;
  simulatedSeconds?: number;
  failureReason?: string;
  plans?: Array<{ actions: string[]; elapsedMinutes: number }>;
};
export const benchmarkVariants = [
  "baseline",
  "reduced_reserve",
  ...variationProfiles.filter((profile) => profile !== "baseline"),
] as const;
export function benchmarkCases(
  repeats = 1,
  variants: readonly string[] = ["baseline", "reduced_reserve"],
  seed = "release"
) {
  const cases: Array<{ state: MissionState; variant: string; repeat: number }> = [];
  for (let repeat = 1; repeat <= repeats; repeat++)
    for (const scenario of scenarioIds)
      for (const variant of variants) {
        const profile = variationProfiles.find((profile) => profile === variant) ?? "baseline";
        const state = createMission(scenario, {
          seed: seed + ":" + scenario + ":" + repeat,
          profile,
        });
        if (variant === "reduced_reserve") {
          state.simulation.conditions = initialConditions({
            ...state.simulation.conditions,
            batteryPct: state.simulation.conditions.batteryPct * 0.85,
            nonessentialLoad: state.simulation.conditions.nonessentialLoad * 1.15,
          });
          state.telemetry = observeMissionTelemetry(
            state.simulation,
            state.scenario,
            state.minutesToImpact
          );
          state.objectiveResults = objectiveResults(state.simulation, state.scenario.objectives);
        }
        cases.push({ state, variant, repeat });
      }
  return cases;
}
function percentile(values: number[], percent: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * percent) - 1)] : undefined;
}
export function summarizeBenchmark(rows: BenchmarkRow[]) {
  const latencies = rows.flatMap((row) =>
    row.approvalReadyMs === undefined ? [] : [row.approvalReadyMs]
  );
  return {
    cases: rows.length,
    resolved: rows.filter((row) => row.status === "resolved").length,
    negativeControls: rows.filter((row) => row.expectedFeasibility === "infeasible_single_proposal")
      .length,
    errors: rows.filter((row) => row.status === "error").length,
    resolutionRate: rows.length
      ? rows.filter((row) => row.status === "resolved").length / rows.length
      : 0,
    approvalReadyP50Ms: percentile(latencies, 0.5),
    approvalReadyP95Ms: percentile(latencies, 0.95),
    consultations: rows.reduce((sum, row) => sum + row.consultations, 0),
    validationRetries: rows.reduce((sum, row) => sum + row.validationRetries, 0),
    estimatedCostUsd: rows.every(
      (row) => row.estimatedCostUsd !== undefined && !row.accountingPending
    )
      ? rows.reduce((sum, row) => sum + row.estimatedCostUsd!, 0)
      : undefined,
  };
}
