import type { IncidentScenario, SystemReading, SystemStatus } from "./mission-contract.js";
import { simulationTelemetry, type Conditions, type Simulation } from "./simulation.js";

export type TelemetrySample = { elapsedMinutes: number; value: string; numericValue?: number };
const historyLimit = 6;
type Sensor = {
  label: string;
  metric: keyof Conditions;
  unit: string;
  detail: string;
  status: (value: number) => SystemStatus;
};
// Thresholds are synthetic training targets, not operational spacecraft limits.
const sensors: Record<IncidentScenario["id"], Sensor[]> = {
  dust_storm: [
    {
      label: "Cabin oxygen",
      metric: "oxygenPct",
      unit: "%",
      detail: "Oxygen concentration responds to air-processing capacity.",
      status: (v) => (v >= 19.5 ? "nominal" : "critical"),
    },
    {
      label: "Cabin carbon dioxide",
      metric: "carbonDioxidePpm",
      unit: "ppm",
      detail: "Carbon dioxide rises with scrubber degradation and falls when processing recovers.",
      status: (v) => (v <= 1000 ? "nominal" : v <= 2000 ? "watch" : "critical"),
    },
    {
      label: "Cabin pressure",
      metric: "cabinPressureKpa",
      unit: "kPa",
      detail: "Habitat pressure reflects the modeled gas-replenishment balance.",
      status: (v) => (v >= 95 ? "nominal" : "critical"),
    },
  ],
  coolant_leak: [
    {
      label: "Coolant flow",
      metric: "coolantFlowLMin",
      unit: "L/min",
      detail: "Circulation falls as coolant is lost and recovers after the line is repaired.",
      status: (v) => (v >= 9.6 ? "nominal" : "critical"),
    },
    {
      label: "Coolant leak rate",
      metric: "coolantLeakRate",
      unit: "%/min",
      detail: "Coolant percentage points lost per simulated minute.",
      status: (v) => (v === 0 ? "nominal" : "critical"),
    },
    {
      label: "Equipment temperature",
      metric: "equipmentTemperatureC",
      unit: "°C",
      detail: "Service-bay equipment warms with poor circulation and cools after recovery.",
      status: (v) => (v <= 65 ? "nominal" : "critical"),
    },
  ],
  relay_failure: [
    {
      label: "Relay signal strength",
      metric: "signalStrengthDbm",
      unit: "dBm",
      detail: "Received signal follows available communications capacity.",
      status: (v) => (v >= -90 ? "nominal" : "critical"),
    },
    {
      label: "Relay packet loss",
      metric: "packetLossPct",
      unit: "%",
      detail: "Lost telemetry packets reflect the communications link's usable capacity.",
      status: (v) => (v <= 20 ? "nominal" : "critical"),
    },
    {
      label: "Backup relay draw",
      metric: "backupRelayDrawPctPerMinute",
      unit: "% battery/min",
      detail: "Additional battery drain from the backup link; zero while it is off.",
      status: (v) => (v > 0 ? "watch" : "nominal"),
    },
  ],
  solar_flare: [
    {
      label: "Radiation flux",
      metric: "radiationFluxMsvPerMinute",
      unit: "mSv/min",
      detail:
        "External radiation increases through the flare; shelter does not change this external reading.",
      status: (v) => (v >= 0.05 ? "critical" : "watch"),
    },
    {
      label: "Accumulated crew dose",
      metric: "crewDoseMsv",
      unit: "mSv",
      detail:
        "Cumulative dose for the most exposed crew member; returning to shelter slows accumulation but never erases prior dose.",
      status: (v) => (v <= 1 ? "nominal" : "critical"),
    },
    {
      label: "Radiation shelter",
      metric: "shelterProtectionPct",
      unit: "% attenuation",
      detail: "Passive shelter protection applies only while the crew is inside.",
      status: (v) => (v >= 95 ? "nominal" : "critical"),
    },
  ],
  rover_recovery: [
    {
      label: "Rover wheel slip",
      metric: "wheelSlipPct",
      unit: "%",
      detail: "Wheel slip falls as the tow rig restores mobility.",
      status: (v) => (v <= 30 ? "nominal" : "critical"),
    },
    {
      label: "Rover motor current",
      metric: "motorCurrentA",
      unit: "A",
      detail: "High current with no progress indicates a stalled drive; travel uses less current.",
      status: (v) => (v >= 30 ? "critical" : "nominal"),
    },
    {
      label: "Distance to safety",
      metric: "distanceToSafetyKm",
      unit: "km",
      detail:
        "Distance decreases proportionally during an explicitly authorized guided return; repair alone does not move the crew.",
      status: (v) => (v === 0 ? "nominal" : "watch"),
    },
  ],
};

const commonSensors: Sensor[] = [
  {
    label: "Air-processing capacity",
    metric: "airProcessingPct",
    unit: "%",
    detail: "Measured air-processing throughput.",
    status: (v) => (v >= 80 ? "nominal" : "critical"),
  },
  {
    label: "Essential electrical draw",
    metric: "essentialLoad",
    unit: "% battery/min",
    detail: "Metered essential load.",
    status: () => "nominal",
  },
  {
    label: "Nonessential electrical draw",
    metric: "nonessentialLoad",
    unit: "% battery/min",
    detail: "Metered discretionary load.",
    status: () => "watch",
  },
  {
    label: "Solar charging rate",
    metric: "solarCharge",
    unit: "% battery/min",
    detail: "Measured charging contribution.",
    status: () => "nominal",
  },
  {
    label: "Power endurance",
    metric: "powerEnduranceMinutes",
    unit: "min",
    detail: "Estimate at the current measured net draw.",
    status: () => "watch",
  },
  {
    label: "Crew outside",
    metric: "crewOutside",
    unit: "outside",
    detail: "Crew position report.",
    status: (v) => (v > 0 ? "watch" : "nominal"),
  },
  {
    label: "Crew return estimate",
    metric: "crewReturnMinutes",
    unit: "min",
    detail:
      "Remaining time for an explicitly authorized guided return once prerequisites hold; zero and not applicable when all crew are inside.",
    status: () => "watch",
  },
  {
    label: "Crew exposure",
    metric: "crewExposureMinutes",
    unit: "min",
    detail:
      "Cumulative minutes outside after hazard arrival or with air processing below 30%; radiation dose is separate.",
    status: (v) => (v > 0 ? "critical" : "nominal"),
  },
  {
    label: "Communications capacity",
    metric: "communicationsPct",
    unit: "%",
    detail: "Measured usable link capacity.",
    status: (v) => (v >= 80 ? "nominal" : "critical"),
  },
  {
    label: "Rover mobility",
    metric: "roverMobilityPct",
    unit: "%",
    detail: "Measured drive capability.",
    status: (v) => (v >= 70 ? "nominal" : "critical"),
  },
];

const coreMetrics: Record<string, [keyof Conditions, string]> = {
  "Habitat battery": ["batteryPct", "%"],
  "Rover battery": ["batteryPct", "%"],
  "EVA crew": ["crewOutside", "outside"],
  "O₂ recycler": ["airProcessingPct", "% capacity"],
  "Thermal loop": ["coolantPct", "% coolant quantity"],
  "Cabin temperature": ["cabinTemperatureC", "°C"],
  "Rover traction": ["roverMobilityPct", "% mobility"],
  "Backup relay": ["communicationsPct", "% capacity"],
  "Comms relay": ["communicationsPct", "% capacity"],
};
function rounded(value: number) {
  return Math.round(value * 1000) / 1000;
}

export function observeMissionTelemetry(
  simulation: Simulation,
  scenario: Pick<IncidentScenario, "id" | "telemetry">,
  minutesToImpact: number,
  previous: SystemReading[] = []
): SystemReading[] {
  const readings = simulationTelemetry(simulation, scenario.telemetry, minutesToImpact).map(
    (reading) => {
      const metric = coreMetrics[reading.label];
      return metric
        ? {
            ...reading,
            metric: metric[0],
            numericValue: rounded(simulation.conditions[metric[0]]),
            unit: metric[1],
          }
        : reading.label === "Storm front"
          ? { ...reading, numericValue: minutesToImpact, unit: "min" }
          : reading;
    }
  );
  for (const sensor of [...sensors[scenario.id], ...commonSensors]) {
    const rawValue = simulation.conditions[sensor.metric];
    const numericValue = rounded(rawValue);
    const reading: SystemReading = {
      label: sensor.label,
      metric: sensor.metric,
      value: numericValue + " " + sensor.unit,
      numericValue,
      unit: sensor.unit,
      detail: sensor.detail,
      status: sensor.status(rawValue),
    };
    const index = readings.findIndex((entry) => entry.label === reading.label);
    if (index >= 0) readings[index] = reading;
    else readings.push(reading);
  }
  const priorReadings = simulation.sensorDelaySeconds
    ? (simulation.sensorSnapshots?.at(-1) ?? previous)
    : previous;
  const observed = readings.map((reading) => {
    const old = priorReadings.find((entry) => entry.label === reading.label);
    const prior = (old?.history ?? []).filter(
      (sample) => sample.elapsedMinutes < simulation.elapsedMinutes
    );
    const sample: TelemetrySample = {
      elapsedMinutes: simulation.elapsedMinutes,
      value: reading.value,
      ...(reading.numericValue === undefined ? {} : { numericValue: reading.numericValue }),
    };
    const history = [...prior, sample].slice(-historyLimit);
    const last = prior.at(-1);
    const trend: SystemReading["trend"] = !last
      ? "insufficient_data"
      : reading.numericValue !== undefined && last.numericValue !== undefined
        ? reading.numericValue > last.numericValue
          ? "rising"
          : reading.numericValue < last.numericValue
            ? "falling"
            : "steady"
        : reading.value === last.value
          ? "steady"
          : "insufficient_data";
    return { ...reading, sampledAtMinutes: simulation.elapsedMinutes, history, trend };
  });
  const delay = simulation.sensorDelaySeconds;
  if (!delay) return observed;
  const snapshots = simulation.sensorSnapshots ?? [];
  const retained = snapshots.filter(
    (batch) => batch[0]?.sampledAtMinutes !== simulation.elapsedMinutes
  );
  retained.push(observed);
  const cutoff = simulation.elapsedMinutes * 60 - delay;
  const older = retained.filter((batch) => (batch[0]?.sampledAtMinutes ?? 0) * 60 <= cutoff);
  simulation.sensorSnapshots = [
    ...older.slice(-1),
    ...retained.filter((batch) => (batch[0]?.sampledAtMinutes ?? 0) * 60 > cutoff),
  ];
  const available = retained.filter(
    (batch) => (batch[0]?.sampledAtMinutes ?? 0) * 60 <= simulation.elapsedMinutes * 60 - delay
  );
  const batch = available.at(-1) ?? retained[0];
  return batch.map((reading) => ({
    ...reading,
    quality: "delayed",
    detail: reading.detail + " Sensor delivery is delayed; use the sample timestamp.",
  }));
}
