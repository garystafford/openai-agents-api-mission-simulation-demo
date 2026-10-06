import {
  simulationSpeed,
  monitoringIntervalMinutes,
  formatSimulationTime,
  recoveryConfirmationSeconds,
  type MissionResponse,
} from "../../server/mission-contract.js";

type Props = {
  mission: MissionResponse;
  blocked: boolean;
  act: (name: string, path: string, body?: unknown) => Promise<void>;
};
export function ExecutionControls({ mission, blocked, act }: Props) {
  const running = mission.execution?.status === "running";
  return (
    <>
      <p className="eyebrow">Accelerated simulation · {running ? "Running" : "Paused"}</p>
      <h2>{running ? "Response executing automatically" : "Execution paused"}</h2>
      <p className="muted">
        {running
          ? `${simulationSpeed} simulated seconds pass every real second. Actions and telemetry update automatically, even if you refresh or close this page.`
          : "Mission time is frozen. Resume when you are ready to continue observing the response."}{" "}
        Success requires all targets to hold for the final minute through hazard arrival. Actual
        power exhaustion or irreversible crew harm stops execution; reserve shortfalls remain failed
        targets.
      </p>
      <p className="execution-status" role="status">
        Simulated time: T+{formatSimulationTime(mission.simulation.elapsedMinutes)} ·{" "}
        {mission.monitoringIntervals} monitoring{" "}
        {mission.monitoringIntervals === 1 ? "report" : "reports"} received
      </p>
      {mission.recoveryStableSinceMinutes !== undefined && (
        <p role="status">
          Confirming stable recovery:{" "}
          {Math.min(
            recoveryConfirmationSeconds,
            Math.round(
              (mission.simulation.elapsedMinutes - mission.recoveryStableSinceMinutes) * 60
            )
          )}{" "}
          / {recoveryConfirmationSeconds} simulated seconds with all targets met. Observation
          continues through hazard arrival.
        </p>
      )}
      {mission.execution?.message && <p role="alert">{mission.execution.message}</p>}
      <button
        onClick={() => void act("playback", "/api/mission/playback", { paused: running })}
        disabled={blocked}
      >
        {running ? "Pause simulation" : "Resume simulation"}
      </button>
      <details className="manual-controls">
        <summary>Debug controls</summary>
        <p className="muted">Pause the simulation to advance one interval manually.</p>
        <button
          className="quiet"
          onClick={() => void act("advance", "/api/mission/advance")}
          disabled={blocked || running}
        >
          Advance {monitoringIntervalMinutes} simulated minutes
        </button>
      </details>
    </>
  );
}
