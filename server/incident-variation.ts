import { initialConditions, type Simulation } from "./simulation.js";
import type { IncidentScenario } from "./mission-contract.js";

export const variationProfiles = [
  "baseline",
  "varied",
  "repair_failure",
  "communications_outage",
  "delayed_sensors",
  "compound",
] as const;
export type VariationProfile = (typeof variationProfiles)[number];
export type IncidentOptions = { seed: string; profile: VariationProfile };
export type Disturbance = {
  kind: "repair_failure" | "communications_outage";
  atSeconds: number;
  durationSeconds?: number;
  applied?: boolean;
  ended?: boolean;
  previousCapacity?: number;
};
function randomFor(seed: string) {
  let value = 2166136261;
  for (const char of seed) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return () => {
    value += 0x6d2b79f5;
    let x = Math.imul(value ^ (value >>> 15), 1 | value);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
export function seededChoice<T>(seed: string, choices: readonly T[]): T {
  if (!choices.length) throw new Error("At least one incident choice is required.");
  return choices[Math.floor(randomFor(seed)() * choices.length)];
}

export function configureIncident(scenario: IncidentScenario, options: IncidentOptions) {
  const random = randomFor(options.seed);
  if (options.profile === "varied" || options.profile === "compound") {
    scenario.initialConditions = initialConditions({
      ...scenario.initialConditions,
      batteryPct: scenario.initialConditions.batteryPct * (0.92 + random() * 0.16),
      crewReturnMinutes:
        Math.round(scenario.initialConditions.crewReturnMinutes * 60 * (0.85 + random() * 0.15)) /
        60,
      nonessentialLoad: scenario.initialConditions.nonessentialLoad * (0.9 + random() * 0.2),
    });
  }
  if (options.profile === "compound") {
    scenario.initialConditions = initialConditions({
      ...scenario.initialConditions,
      scrubberFault: 1,
      airProcessingPct: 65,
      carbonDioxidePpm: 1400,
    });
    if (!scenario.availableActions.includes("isolate_scrubber"))
      scenario.availableActions.push("isolate_scrubber");
    if (!scenario.objectives.some((goal) => goal.metric === "airProcessingPct"))
      scenario.objectives.push({
        metric: "airProcessingPct",
        label: "Air processing",
        comparison: "at_least",
        target: 80,
        unit: "%",
      });
    scenario.activeRisks.push("Additional air-processing deterioration");
  }
}
export function incidentDisturbances(options: IncidentOptions): Disturbance[] {
  if (options.profile === "repair_failure") return [{ kind: "repair_failure", atSeconds: 60 }];
  if (options.profile === "communications_outage")
    return [{ kind: "communications_outage", atSeconds: 270, durationSeconds: 120 }];
  return [];
}
export function applyDisturbances(simulation: Simulation) {
  const c = simulation.conditions;
  const second = Math.round(simulation.elapsedMinutes * 60) + 1;
  for (const fault of simulation.disturbances ?? []) {
    if (second < fault.atSeconds || fault.ended) continue;
    if (fault.kind === "repair_failure") {
      const command = simulation.commands.find(
        (command) =>
          command.action === "deploy_repair_drone" &&
          ["pending", "running"].includes(command.status)
      );
      if (!command) continue;
      command.status = "failed";
      command.detail =
        "Repair interrupted by a transient actuator trip. Inspection reports the drone can be retried under a newly authorized plan.";
      fault.applied = true;
      fault.ended = true;
    } else {
      if (!fault.applied) fault.previousCapacity = c.communicationsPct;
      fault.applied = true;
      if (second >= fault.atSeconds + (fault.durationSeconds ?? 0)) {
        c.communicationsPct =
          c.batteryPct > 0 ? (c.backupRelayOnline ? 100 : (fault.previousCapacity ?? 0)) : 0;
        fault.ended = true;
      } else c.communicationsPct = 0;
    }
  }
}
