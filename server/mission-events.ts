import { formatSimulationTime, type MissionEvent, type MissionState } from "./mission-contract.js";

export function missionEvent(
  state: Pick<MissionState, "simulation">,
  entry: Omit<MissionEvent, "time" | "occurredAt" | "simulatedAtMinutes">,
  now = new Date()
): MissionEvent {
  return structuredClone({
    ...(Object.fromEntries(
      Object.entries(entry).filter(([, value]) => value !== undefined)
    ) as typeof entry),
    time: "T+" + formatSimulationTime(state.simulation.elapsedMinutes),
    occurredAt: now.toISOString(),
    simulatedAtMinutes: state.simulation.elapsedMinutes,
  });
}
