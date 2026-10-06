import { useState } from "react";
import type { MissionResponse } from "../../server/mission-contract.js";

const profiles = {
  baseline: "Baseline incident",
  varied: "Varied reserves and travel time",
  repair_failure: "Repair actuator interruption",
  communications_outage: "Temporary communications outage",
  delayed_sensors: "Delayed sensor delivery",
  compound: "Combined incident and air-processing fault",
};
export function IncidentSetup({
  mission,
  blocked,
  start,
}: {
  mission: MissionResponse;
  blocked: boolean;
  start: (body: unknown) => Promise<void>;
}) {
  const [scenarioId, setScenarioId] = useState("random");
  const [profile, setProfile] = useState("baseline");
  const [seed, setSeed] = useState("ares-demo-1");
  return (
    <details className="panel incident-setup">
      <summary>Incident setup and reproducible variations</summary>
      <p>
        Choose an incident and variation. The same seed and settings recreate its initial conditions
        and disturbances; agent decisions may vary.
      </p>
      {mission.variation && (
        <p>
          Current variation: {profiles[mission.variation.profile]} · Seed: {mission.variation.seed}
        </p>
      )}
      <label>
        Incident{" "}
        <select
          value={scenarioId}
          onChange={(event) => setScenarioId(event.target.value)}
          disabled={blocked}
        >
          <option value="random">Random incident</option>
          <option value="dust_storm">Dust storm</option>
          <option value="coolant_leak">Coolant leak</option>
          <option value="relay_failure">Relay failure</option>
          <option value="solar_flare">Solar flare</option>
          <option value="rover_recovery">Stranded rover</option>
        </select>
      </label>
      <label>
        Variation{" "}
        <select
          value={profile}
          onChange={(event) => setProfile(event.target.value)}
          disabled={blocked}
        >
          {Object.entries(profiles).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Replay seed{" "}
        <input
          value={seed}
          onChange={(event) => setSeed(event.target.value)}
          maxLength={80}
          disabled={blocked}
        />
      </label>
      <p>
        Repair interruptions affect a deployed drone. Temporary outages begin after four and a half
        simulated minutes. Delayed sensors retain their original sample times.
      </p>
      <button
        disabled={blocked || !seed.trim()}
        onClick={() =>
          void start({
            ...(scenarioId === "random" ? {} : { scenarioId }),
            profile,
            seed: seed.trim(),
          })
        }
      >
        Start configured incident
      </button>
    </details>
  );
}
