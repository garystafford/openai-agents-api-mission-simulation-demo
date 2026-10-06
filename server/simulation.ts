import { applyDisturbances, type Disturbance } from "./incident-variation.js";
import {
  monitoringIntervalMinutes,
  type MissionAction,
  type SystemReading,
} from "./mission-contract.js";

export type Conditions = {
  batteryPct: number;
  essentialLoad: number;
  nonessentialLoad: number;
  solarCharge: number;
  powerEnduranceMinutes: number;
  airProcessingPct: number;
  scrubberFault: number;
  coolantPct: number;
  coolantLeakRate: number;
  cabinTemperatureC: number;
  crewOutside: number;
  crewReturnMinutes: number;
  crewExposureMinutes: number;
  communicationsPct: number;
  backupRelayOnline: number;
  roverMobilityPct: number;
  weatherConfidencePct: number;
  oxygenPct: number;
  carbonDioxidePpm: number;
  cabinPressureKpa: number;
  coolantFlowLMin: number;
  equipmentTemperatureC: number;
  signalStrengthDbm: number;
  packetLossPct: number;
  backupRelayDrawPctPerMinute: number;
  radiationFluxMsvPerMinute: number;
  radiationGrowthPerMinute: number;
  crewDoseMsv: number;
  shelterProtectionPct: number;
  wheelSlipPct: number;
  motorCurrentA: number;
  distanceToSafetyKm: number;
};
export type Objective = {
  metric: keyof Conditions;
  label: string;
  comparison: "at_least" | "at_most";
  target: number;
  unit: string;
};
export type ObjectiveResult = Objective & { actual: number; met: boolean };
export type InitialConditions = Conditions & { repairTarget: "coolant" | "rover" | "none" };
export type ActionExecution = {
  action: MissionAction;
  status: "pending" | "running" | "succeeded" | "failed";
  progressMinutes: number;
  detail: string;
};
export type Simulation = {
  conditions: InitialConditions;
  elapsedMinutes: number;
  commands: ActionExecution[];
  history: ActionExecution[][];
  disturbances?: Disturbance[];
  sensorDelaySeconds?: number;
  sensorSnapshots?: SystemReading[][];
};

export const actionCapabilities: Record<MissionAction, string> = {
  recall_eva:
    "Explicitly guide outside crew home using the remaining return estimate, with distance decreasing proportionally. Requires mobility >=50%; the incident-specific recallPrerequisites specifies whether communications >=80% is required. This link gate applies to stranded-rover recovery, not ordinary recall in relay-failure or solar-flare incidents. No return is automatic after repair. Arrival sets crew outside, remaining time and distance to zero.",
  shed_nonessential_load:
    "Turn off nonessential electrical loads in 4 minutes. Essential loads remain powered.",
  isolate_scrubber:
    "Isolate the faulty secondary loop in 8 minutes, restoring primary air processing to 95% capacity.",
  verify_orbital_weather:
    "Cross-check weather confidence in 4 minutes. Verification changes knowledge, not the hazard arrival time.",
  deploy_repair_drone:
    "Repair the damaged coolant line or rover in 8 working minutes. Consumes 1.5 battery percentage points per working minute (12 total over 8 minutes); rover recovery alone needs an 80% communications link (internal coolant repair does not). Coolant repair restores 95% quantity and stops the leak; rover repair restores 85% mobility and 15% wheel slip. Waits for a missing link, fails without sufficient power.",
  switch_to_backup_relay:
    "Bring the protected backup link online in 4 minutes, restoring communications to 100% and adding 0.15 battery percentage points of draw per minute.",
};

function endurance(c: Conditions) {
  const draw = c.essentialLoad + c.nonessentialLoad + c.backupRelayOnline * 0.15 - c.solarCharge;
  return draw <= 0 ? 999 : Math.min(999, c.batteryPct / draw);
}
export function initialConditions(overrides: Partial<InitialConditions> = {}): InitialConditions {
  const c: InitialConditions = {
    batteryPct: 61,
    essentialLoad: 0.4,
    nonessentialLoad: 1,
    solarCharge: 0.1,
    powerEnduranceMinutes: 0,
    airProcessingPct: 100,
    scrubberFault: 0,
    coolantPct: 100,
    coolantLeakRate: 0,
    cabinTemperatureC: 22,
    crewOutside: 0,
    crewReturnMinutes: 11,
    crewExposureMinutes: 0,
    communicationsPct: 100,
    backupRelayOnline: 0,
    roverMobilityPct: 100,
    weatherConfidencePct: 60,
    oxygenPct: 20.9,
    carbonDioxidePpm: 600,
    cabinPressureKpa: 101.2,
    coolantFlowLMin: 12,
    equipmentTemperatureC: 35,
    signalStrengthDbm: -55,
    packetLossPct: 0,
    backupRelayDrawPctPerMinute: 0,
    radiationFluxMsvPerMinute: 0,
    radiationGrowthPerMinute: 0,
    crewDoseMsv: 0,
    shelterProtectionPct: 98,
    wheelSlipPct: 0,
    motorCurrentA: 2,
    distanceToSafetyKm: 0,
    repairTarget: "none",
    ...overrides,
  };
  if (c.crewOutside === 0) {
    c.crewReturnMinutes = 0;
    c.distanceToSafetyKm = 0;
  }
  refreshDiagnostics(c);
  return c;
}
function refreshDiagnostics(c: InitialConditions) {
  c.coolantFlowLMin = c.coolantPct * 0.12;
  c.signalStrengthDbm = -120 + c.communicationsPct * 0.65;
  c.packetLossPct = 100 - c.communicationsPct;
  c.backupRelayDrawPctPerMinute = c.backupRelayOnline * 0.15;
  c.wheelSlipPct = 100 - c.roverMobilityPct;
  c.powerEnduranceMinutes = endurance(c);
}

export function createSimulation(conditions: InitialConditions): Simulation {
  return { conditions: structuredClone(conditions), elapsedMinutes: 0, commands: [], history: [] };
}
export function objectiveResults(
  simulation: Simulation,
  objectives: Objective[]
): ObjectiveResult[] {
  return objectives.map((objective) => {
    const actual = simulation.conditions[objective.metric];
    return {
      ...objective,
      actual,
      met:
        objective.comparison === "at_least"
          ? actual + 1e-8 >= objective.target
          : actual <= objective.target + 1e-8,
    };
  });
}
export function beginExecution(simulation: Simulation, actions: MissionAction[]): Simulation {
  const next = structuredClone(simulation);
  if (next.commands.length) next.history.push(next.commands);
  next.commands = actions.map((action) => ({
    action,
    status: "pending",
    progressMinutes: 0,
    detail: "Awaiting simulated execution.",
  }));
  return next;
}

function execute(command: ActionExecution, c: InitialConditions, minutes: number) {
  if (command.status === "succeeded" || command.status === "failed") return;
  if (c.batteryPct <= 0) {
    command.status = "failed";
    command.detail = "No electrical reserve remains to execute this command.";
    return;
  }
  if (
    command.action === "deploy_repair_drone" &&
    c.repairTarget === "rover" &&
    c.communicationsPct < 80
  ) {
    command.status = "pending";
    command.detail = "Waiting for a communications link strong enough to control the tow rig.";
    return;
  }
  if (
    command.action === "recall_eva" &&
    c.crewOutside > 0 &&
    (c.roverMobilityPct < 50 || (c.repairTarget === "rover" && c.communicationsPct < 80))
  ) {
    command.status = "pending";
    command.detail = "Crew cannot return until rover mobility is restored.";
    return;
  }
  command.status = "running";
  const work = Math.min(minutes, command.action === "recall_eva" ? c.crewReturnMinutes : minutes);
  if (
    command.action === "deploy_repair_drone" &&
    c.repairTarget !== "none" &&
    c.batteryPct + 1e-8 < work * 1.5
  ) {
    command.status = "failed";
    command.detail = "Insufficient reserve for the drone's next working interval.";
    return;
  }
  command.progressMinutes = Math.round((command.progressMinutes + work) * 60) / 60;
  let complete = false;
  switch (command.action) {
    case "shed_nonessential_load":
      complete = command.progressMinutes >= 4;
      if (complete) c.nonessentialLoad = 0;
      command.detail = complete
        ? "Nonessential loads are offline; essential systems retain power."
        : "Nonessential load shedding is underway.";
      break;
    case "switch_to_backup_relay":
      complete = command.progressMinutes >= 4;
      if (complete) {
        c.backupRelayOnline = 1;
        c.communicationsPct = 100;
      }
      command.detail = complete
        ? "Protected backup communications are online; reserve draw has increased."
        : "Backup communications activation is underway.";
      break;
    case "verify_orbital_weather":
      complete = command.progressMinutes >= 4;
      if (complete) c.weatherConfidencePct = 100;
      command.detail = complete
        ? "Weather observations verified. Physical conditions are unchanged."
        : "Weather cross-check is underway.";
      break;
    case "isolate_scrubber":
      complete = command.progressMinutes >= 8;
      if (complete) {
        c.airProcessingPct = 95;
        c.scrubberFault = 0;
      }
      command.detail = complete
        ? "Faulty loop isolated; primary air processing is at 95% capacity."
        : "Secondary loop isolation is underway.";
      break;
    case "recall_eva":
      c.crewReturnMinutes = Math.max(0, Math.round((c.crewReturnMinutes - work) * 60) / 60);
      complete = c.crewOutside === 0 || c.crewReturnMinutes === 0;
      if (complete) c.crewOutside = 0;
      command.detail = complete
        ? "Crew is safely inside the habitat."
        : "Return underway; approximately " +
          Math.round(c.crewReturnMinutes * 10) / 10 +
          " minutes remain.";
      break;
    case "deploy_repair_drone":
      if (c.repairTarget === "none") {
        complete = command.progressMinutes >= 4;
        command.detail = complete
          ? "Inspection completed; no supported mechanical repair target was present."
          : "Mechanical inspection is underway.";
        break;
      }
      c.batteryPct = Math.max(0, c.batteryPct - work * 1.5);
      complete = command.progressMinutes >= 8;
      if (complete && c.repairTarget === "coolant") {
        c.coolantPct = 95;
        c.coolantLeakRate = 0;
      }
      if (complete && c.repairTarget === "rover") c.roverMobilityPct = 85;
      command.detail = complete
        ? "Mechanical repair completed and verified."
        : "Mechanical repair is underway.";
      break;
  }
  if (complete) command.status = "succeeded";
}

function stepSimulationSlice(
  simulation: Simulation,
  minutesToImpact: number,
  minutes: number
): Simulation {
  const next = structuredClone(simulation);
  const c = next.conditions;
  applyDisturbances(next);
  // Recovery communications are sampled at the start of the interval so command
  // list order cannot make a newly activated relay enable a drone immediately.
  const linkAtStart = c.communicationsPct;
  const mobilityAtStart = c.roverMobilityPct;
  const outsideAtStart = c.crewOutside;
  const returnTimeAtStart = c.crewReturnMinutes;
  const distanceAtStart = c.distanceToSafetyKm;
  const radiationAtStart = c.radiationFluxMsvPerMinute;
  const draw = c.essentialLoad + c.nonessentialLoad + c.backupRelayOnline * 0.15 - c.solarCharge;
  c.batteryPct = Math.max(0, Math.min(100, c.batteryPct - draw * minutes));
  c.coolantPct = Math.max(0, c.coolantPct - c.coolantLeakRate * minutes);
  c.cabinTemperatureC = Math.max(
    22,
    c.cabinTemperatureC +
      (c.coolantPct < 80 ? (100 - c.coolantPct) * 0.015 * minutes : -0.5 * minutes)
  );
  c.airProcessingPct = Math.max(0, c.airProcessingPct - c.scrubberFault * minutes);
  if (c.batteryPct === 0) {
    c.communicationsPct = 0;
    c.airProcessingPct = Math.max(0, c.airProcessingPct - minutes * 10);
  }
  // Count exposure that occurred during the interval, including a return after
  // the hazard arrived but before this observation was recorded.
  const outsideDuration = outsideAtStart > 0 ? minutes : 0;
  const externalExposure = Math.max(0, outsideDuration - Math.max(0, minutesToImpact));
  c.crewExposureMinutes += Math.max(externalExposure, c.airProcessingPct < 30 ? minutes : 0);
  // Synthetic training dynamics: diagnostic sensors follow system conditions,
  // and cumulative exposure survives later repairs and additional responses.
  if (c.airProcessingPct < 80) {
    const deficit = 100 - c.airProcessingPct;
    c.oxygenPct = Math.max(0, c.oxygenPct - deficit * 0.0015 * minutes);
    c.carbonDioxidePpm += deficit * 2 * minutes;
    c.cabinPressureKpa = Math.max(0, c.cabinPressureKpa - deficit * 0.0005 * minutes);
  } else {
    c.oxygenPct = Math.min(20.9, c.oxygenPct + 0.15 * minutes);
    c.carbonDioxidePpm = Math.max(600, c.carbonDioxidePpm - 300 * minutes);
    c.cabinPressureKpa = Math.min(101.2, c.cabinPressureKpa + 0.04 * minutes);
  }
  refreshDiagnostics(c);
  c.equipmentTemperatureC = Math.max(
    35,
    c.equipmentTemperatureC +
      (c.coolantFlowLMin < 9.6 ? (1 - c.coolantFlowLMin / 12) * 2 * minutes : -3 * minutes)
  );
  c.radiationFluxMsvPerMinute += c.radiationGrowthPerMinute * minutes;
  const integratedDose = (duration: number) =>
    radiationAtStart * duration + 0.5 * c.radiationGrowthPerMinute * duration * duration;
  const outsideDose = integratedDose(outsideDuration);
  c.crewDoseMsv +=
    outsideDose + (integratedDose(minutes) - outsideDose) * (1 - c.shelterProtectionPct / 100);
  for (const command of next.commands) {
    if (command.status === "succeeded" || command.status === "failed") continue;
    if (
      command.action === "recall_eva" &&
      outsideAtStart > 0 &&
      (mobilityAtStart < 50 || (c.repairTarget === "rover" && linkAtStart < 80))
    ) {
      command.detail = "Crew cannot return until rover mobility is restored.";
      continue;
    }
    if (
      command.action === "deploy_repair_drone" &&
      c.repairTarget === "rover" &&
      linkAtStart < 80
    ) {
      command.detail = "Waiting for the recovery communications link.";
      continue;
    }
    execute(command, c, minutes);
  }
  if (
    next.disturbances?.some(
      (fault) => fault.kind === "communications_outage" && fault.applied && !fault.ended
    )
  )
    c.communicationsPct = 0;
  refreshDiagnostics(c);
  const returning = c.crewReturnMinutes < returnTimeAtStart;
  if (returning && returnTimeAtStart > 0) {
    c.distanceToSafetyKm = (distanceAtStart * c.crewReturnMinutes) / returnTimeAtStart;
  }
  c.motorCurrentA =
    c.batteryPct <= 0
      ? 0
      : c.distanceToSafetyKm < distanceAtStart
        ? 12
        : c.roverMobilityPct < 50
          ? 32
          : 2;
  next.elapsedMinutes = Math.round((next.elapsedMinutes + minutes) * 60) / 60;
  return next;
}

// Integrate synthetic dynamics in one-second slices, independently of reporting or playback cadence.
export function stepSimulation(
  simulation: Simulation,
  minutesToImpact: number,
  minutes = monitoringIntervalMinutes
): Simulation {
  let next = structuredClone(simulation);
  const seconds = Math.max(0, Math.round(minutes * 60));
  for (let second = 0; second < seconds; second++)
    next = stepSimulationSlice(next, Math.max(0, minutesToImpact - second / 60), 1 / 60);
  return next;
}

export function simulationTelemetry(
  simulation: Simulation,
  readings: SystemReading[],
  minutesToImpact: number
): SystemReading[] {
  const c = simulation.conditions;
  const rounded = (value: number) => Math.round(value * 10) / 10;
  return readings.map((reading): SystemReading => {
    switch (reading.label) {
      case "Habitat battery":
      case "Rover battery":
        return {
          ...reading,
          value: rounded(c.batteryPct) + "%",
          status: c.batteryPct >= 20 ? "watch" : "critical",
          detail:
            "Estimated endurance: " +
            rounded(c.powerEnduranceMinutes) +
            " minutes at current net draw.",
        };
      case "EVA crew":
        return {
          ...reading,
          value: c.crewOutside === 0 ? "Airlock secured" : c.crewOutside + " outside",
          status: c.crewOutside === 0 ? "nominal" : "critical",
          detail:
            c.crewOutside === 0
              ? "Crew safely inside."
              : "Return time with mobility available: " + c.crewReturnMinutes + " minutes.",
        };
      case "Traverse crew":
        return {
          ...reading,
          value: c.communicationsPct >= 80 ? "Voice link stable" : "Beacon only",
          status: c.communicationsPct >= 80 && c.roverMobilityPct >= 50 ? "nominal" : "critical",
          detail:
            "Communications: " +
            c.communicationsPct +
            "%; rover mobility: " +
            c.roverMobilityPct +
            "%.",
        };
      case "O₂ recycler":
        return {
          ...reading,
          value: rounded(c.airProcessingPct) + "% capacity",
          status: c.airProcessingPct >= 80 ? "nominal" : "critical",
          detail: c.scrubberFault
            ? "Faulty secondary loop is degrading air processing."
            : "Primary air processing is stable.",
        };
      case "Thermal loop":
        return {
          ...reading,
          value: rounded(c.coolantPct) + "% coolant quantity",
          status: c.coolantPct >= 80 ? "nominal" : "critical",
          detail: "Coolant loss: " + c.coolantLeakRate + " percentage points per minute.",
        };
      case "Cabin temperature":
        return {
          ...reading,
          value: rounded(c.cabinTemperatureC) + "°C",
          status: c.cabinTemperatureC <= 30 ? "nominal" : "critical",
          detail: "Temperature responds to coolant integrity.",
        };
      case "Rover traction":
        return {
          ...reading,
          value: c.roverMobilityPct + "% mobility",
          status: c.roverMobilityPct >= 70 ? "nominal" : "critical",
          detail: "Measured ability to leave the crater.",
        };
      case "Backup relay":
      case "Comms relay":
        return {
          ...reading,
          value: c.backupRelayOnline ? "Backup online" : reading.value,
          status: c.communicationsPct >= 80 ? "nominal" : "critical",
          detail: "Resilient communications capacity: " + c.communicationsPct + "%.",
        };
      case "Storm front":
        return {
          ...reading,
          value: Math.round(minutesToImpact * 10) / 10 + " min",
          status: minutesToImpact <= 10 ? "critical" : "watch",
          detail: "Time until external conditions exceed the response window.",
        };
      case "Repair drone": {
        const command = simulation.commands.find((entry) => entry.action === "deploy_repair_drone");
        return command
          ? {
              ...reading,
              value: command.status,
              status:
                command.status === "failed"
                  ? "critical"
                  : command.status === "succeeded"
                    ? "nominal"
                    : "watch",
              detail: command.detail,
            }
          : reading;
      }
      default:
        return reading;
    }
  });
}
