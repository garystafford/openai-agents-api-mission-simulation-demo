import { useEffect, useRef, useState } from "react";
import {
  executionIntervalMs,
  formatSimulationTime,
  simulationSpeed,
  type MissionResponse,
} from "../../server/mission-contract.js";

export function MissionClock({ mission }: { mission: MissionResponse }) {
  const authoritative = mission.simulation.elapsedMinutes;
  const [displayed, setDisplayed] = useState({
    missionId: mission.missionId,
    elapsed: authoritative,
  });
  const current = useRef(authoritative);
  const running = mission.phase === "executing" && mission.execution?.status === "running";
  useEffect(() => {
    let frame: number;
    const from = current.current;
    const started = performance.now();
    const update = (now: number) => {
      // Interpolate committed state only. Never predict that a command or outcome has occurred.
      const fraction = running ? Math.min(1, (now - started) / executionIntervalMs) : 1;
      const elapsed = from + (authoritative - from) * fraction;
      current.current = elapsed;
      setDisplayed({ missionId: mission.missionId, elapsed });
      if (fraction < 1) frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [authoritative, running, mission.missionId]);
  const elapsed =
    displayed.missionId === mission.missionId && running ? displayed.elapsed : authoritative;
  const remaining = mission.minutesToImpact + authoritative - elapsed;
  return (
    <div>
      <p className="eyebrow">Mission clock</p>
      <div className="countdown" aria-label="Simulated time until impact">
        {formatSimulationTime(remaining, true)}
      </div>
      <p className="muted">Simulated time until impact</p>
      <p className="clock-mode">
        {mission.phase === "executing"
          ? running
            ? `Accelerated simulation · ${simulationSpeed}× speed`
            : "Simulation paused · time is frozen"
          : mission.outcome === "degraded"
            ? "Execution stopped · new authorization required"
            : mission.phase === "resolved" || mission.phase === "failed"
              ? "Simulation stopped · outcome measured"
              : "Clock starts after authorization"}
      </p>
      <p className="clock-elapsed">Elapsed simulation: T+{formatSimulationTime(elapsed)}</p>
    </div>
  );
}
