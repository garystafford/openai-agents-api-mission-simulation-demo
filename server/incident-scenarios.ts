import { initialConditions } from "./simulation.js";
import type { IncidentScenario } from "./mission-contract.js";

export const scenarioIds: IncidentScenario["id"][] = [
  "dust_storm",
  "coolant_leak",
  "relay_failure",
  "solar_flare",
  "rover_recovery",
];

export const scenarios: Record<IncidentScenario["id"], IncidentScenario> = {
  dust_storm: {
    id: "dust_storm",
    initialConditions: initialConditions({
      crewOutside: 1,
      airProcessingPct: 55,
      scrubberFault: 1,
      oxygenPct: 20.2,
      carbonDioxidePpm: 1600,
      cabinPressureKpa: 100.8,
      distanceToSafetyKm: 2.7,
    }),
    objectives: [
      {
        metric: "oxygenPct",
        label: "Cabin oxygen",
        comparison: "at_least",
        target: 19.5,
        unit: "%",
      },
      {
        metric: "carbonDioxidePpm",
        label: "Cabin carbon dioxide",
        comparison: "at_most",
        target: 2000,
        unit: "ppm",
      },
      {
        metric: "cabinPressureKpa",
        label: "Cabin pressure",
        comparison: "at_least",
        target: 95,
        unit: "kPa",
      },

      {
        metric: "crewOutside",
        label: "Crew sheltered",
        comparison: "at_most",
        target: 0,
        unit: "outside",
      },
      {
        metric: "airProcessingPct",
        label: "Air processing",
        comparison: "at_least",
        target: 80,
        unit: "%",
      },
      {
        metric: "powerEnduranceMinutes",
        label: "Essential power endurance",
        comparison: "at_least",
        target: 90,
        unit: "min",
      },
      {
        metric: "batteryPct",
        label: "Electrical reserve",
        comparison: "at_least",
        target: 20,
        unit: "%",
      },
      {
        metric: "crewExposureMinutes",
        label: "Crew exposure",
        comparison: "at_most",
        target: 0,
        unit: "min",
      },
    ],
    title: "Approaching Martian Dust Storm",
    briefing:
      "A dust storm reaches Ares-7 in 18 minutes. One EVA crew member is outside while solar output is collapsing and the oxygen recycler is unstable.",
    minutesToImpact: 18,
    activeRisks: [
      "Crew is outside",
      "Breathable cabin loop is unstable",
      "Solar power is degrading",
    ],
    verification: {
      orbital:
        "Orbital weather cross-check confirms the current hazard forecast. Verification changes confidence, not the fixed response deadline.",
      maintenance:
        "Maintenance review: the secondary scrubber loop can be isolated without damaging the primary loop.",
      crew: "EVA crew report: rover is operational and route Bravo remains passable for approximately 14 minutes.",
    },
    availableActions: [
      "recall_eva",
      "shed_nonessential_load",
      "isolate_scrubber",
      "verify_orbital_weather",
      "deploy_repair_drone",
    ],
    telemetry: [
      {
        label: "Storm front",
        value: "18 min",
        status: "critical",
        detail: "Wind wall accelerating 16% above forecast.",
      },
      {
        label: "Solar array",
        value: "31% output",
        status: "critical",
        detail: "Dust accumulation is rising.",
      },
      {
        label: "O₂ recycler",
        value: "Fault E-17",
        status: "critical",
        detail: "CO₂ scrubber loop is oscillating.",
      },
      {
        label: "Habitat battery",
        value: "61%",
        status: "watch",
        detail: "Enough for one high-load survival window.",
      },
      {
        label: "EVA crew",
        value: "1 outside",
        status: "watch",
        detail: "Rover is 2.7 km from habitat.",
      },
      {
        label: "Cabin pressure",
        value: "101.2 kPa",
        status: "nominal",
        detail: "Habitat pressure remains stable despite the scrubber fault.",
      },
    ],
  },
  coolant_leak: {
    id: "coolant_leak",
    initialConditions: initialConditions({
      batteryPct: 54,
      essentialLoad: 0.4,
      nonessentialLoad: 1.1,
      solarCharge: 0,
      coolantPct: 42,
      coolantLeakRate: 4,
      cabinTemperatureC: 27.8,
      equipmentTemperatureC: 62,
      repairTarget: "coolant",
    }),
    objectives: [
      {
        metric: "coolantFlowLMin",
        label: "Coolant circulation",
        comparison: "at_least",
        target: 9.6,
        unit: "L/min",
      },
      {
        metric: "equipmentTemperatureC",
        label: "Equipment temperature",
        comparison: "at_most",
        target: 65,
        unit: "°C",
      },

      {
        metric: "coolantPct",
        label: "Coolant quantity",
        comparison: "at_least",
        target: 80,
        unit: "%",
      },
      {
        metric: "cabinTemperatureC",
        label: "Cabin temperature",
        comparison: "at_most",
        target: 30,
        unit: "°C",
      },
      {
        metric: "batteryPct",
        label: "Electrical reserve",
        comparison: "at_least",
        target: 20,
        unit: "%",
      },
      {
        metric: "crewExposureMinutes",
        label: "Crew exposure",
        comparison: "at_most",
        target: 0,
        unit: "min",
      },
    ],
    title: "Habitat Coolant Leak",
    briefing:
      "A coolant leak is spreading through the thermal loop. The habitat is warm, a repair drone is available, and the crew is inside, but repairs consume limited electrical reserves.",
    minutesToImpact: 24,
    activeRisks: [
      "Coolant quantity is falling",
      "Cabin heat is rising",
      "Repair consumes electrical reserve",
    ],
    verification: {
      orbital:
        "Orbital thermal image: the exterior radiator is intact; the leak likely originates in the habitat service bay.",
      maintenance:
        "Maintenance review: the repair drone can seal the service-bay line, but deployment draws a high transient power load.",
      crew: "Crew report: service bay is clear, but manual repair would expose a crew member to a hot-surface hazard.",
    },
    availableActions: [
      "shed_nonessential_load",
      "deploy_repair_drone",
      "switch_to_backup_relay",
      "verify_orbital_weather",
    ],
    telemetry: [
      {
        label: "Thermal loop",
        value: "42% coolant quantity",
        status: "critical",
        detail: "Coolant loss is accelerating in the service bay.",
      },
      {
        label: "Cabin temperature",
        value: "27.8°C",
        status: "watch",
        detail: "Rising 0.7°C every 6 minutes.",
      },
      {
        label: "Repair drone",
        value: "Ready",
        status: "nominal",
        detail: "Sealant cartridge and diagnostic arm are available.",
      },
      {
        label: "Habitat battery",
        value: "54%",
        status: "watch",
        detail: "Drone deployment requires a temporary high-load window.",
      },
      {
        label: "Comms relay",
        value: "Primary online",
        status: "watch",
        detail: "Thermal-loop isolation could interrupt the primary relay.",
      },
      {
        label: "Exterior radiator",
        value: "Intact",
        status: "nominal",
        detail: "Thermal imaging confirms the leak is inside the service bay.",
      },
    ],
  },
  relay_failure: {
    id: "relay_failure",
    initialConditions: initialConditions({
      batteryPct: 48,
      essentialLoad: 0.35,
      nonessentialLoad: 0.05,
      solarCharge: 0,
      communicationsPct: 0,
      crewOutside: 2,
    }),
    objectives: [
      {
        metric: "crewOutside",
        label: "Crew sheltered",
        comparison: "at_most",
        target: 0,
        unit: "outside",
      },

      {
        metric: "packetLossPct",
        label: "Communications packet loss",
        comparison: "at_most",
        target: 20,
        unit: "%",
      },

      {
        metric: "communicationsPct",
        label: "Resilient communications",
        comparison: "at_least",
        target: 80,
        unit: "%",
      },
      {
        metric: "batteryPct",
        label: "Electrical reserve",
        comparison: "at_least",
        target: 20,
        unit: "%",
      },
      {
        metric: "crewExposureMinutes",
        label: "Crew exposure",
        comparison: "at_most",
        target: 0,
        unit: "min",
      },
    ],
    title: "Orbital Relay Failure",
    briefing:
      "The primary orbital relay has failed during a worsening dust storm. A science traverse is beyond line of sight, the backup relay is available, and power reserve is limited.",
    minutesToImpact: 31,
    activeRisks: [
      "Traverse crew is beyond line of sight",
      "Primary communications relay is down",
      "Backup relay draws from a limited battery",
    ],
    verification: {
      orbital:
        "Orbital diagnostic: the relay fault is localized to the primary antenna controller; no solar flare is present.",
      maintenance:
        "Maintenance review: the backup relay will provide voice and low-rate telemetry but consumes 9% battery per hour.",
      crew: "Traverse crew beacon: automatic position pings remain available, but two-way voice contact is not restored.",
    },
    availableActions: [
      "switch_to_backup_relay",
      "shed_nonessential_load",
      "verify_orbital_weather",
      "recall_eva",
    ],
    telemetry: [
      {
        label: "Primary relay",
        value: "Offline",
        status: "critical",
        detail: "Antenna controller is not responding.",
      },
      {
        label: "Traverse crew",
        value: "2 beyond line of sight",
        status: "critical",
        detail: "Automatic beacon only; no voice confirmation.",
      },
      {
        label: "Backup relay",
        value: "Standby",
        status: "watch",
        detail: "Low-rate voice and telemetry available at high battery cost.",
      },
      {
        label: "Habitat battery",
        value: "48%",
        status: "watch",
        detail: "Dust cover limits solar recharge for the next 6 hours.",
      },
      {
        label: "Storm front",
        value: "31 min",
        status: "watch",
        detail: "Visibility is expected to worsen on the traverse route.",
      },
      {
        label: "Antenna controller",
        value: "No response",
        status: "critical",
        detail: "Primary relay recovery cannot be attempted during this response.",
      },
    ],
  },
  solar_flare: {
    id: "solar_flare",
    initialConditions: initialConditions({
      batteryPct: 66,
      essentialLoad: 0.45,
      nonessentialLoad: 1,
      solarCharge: 0,
      crewOutside: 1,
      communicationsPct: 35,
      radiationFluxMsvPerMinute: 0.02,
      radiationGrowthPerMinute: 0.005,
      distanceToSafetyKm: 2.7,
    }),
    objectives: [
      {
        metric: "crewDoseMsv",
        label: "Accumulated crew dose",
        comparison: "at_most",
        target: 1,
        unit: "mSv",
      },
      {
        metric: "shelterProtectionPct",
        label: "Shelter attenuation",
        comparison: "at_least",
        target: 95,
        unit: "%",
      },

      {
        metric: "crewOutside",
        label: "Crew sheltered",
        comparison: "at_most",
        target: 0,
        unit: "outside",
      },
      {
        metric: "communicationsPct",
        label: "Resilient communications",
        comparison: "at_least",
        target: 80,
        unit: "%",
      },
      {
        metric: "powerEnduranceMinutes",
        label: "Essential power endurance",
        comparison: "at_least",
        target: 80,
        unit: "min",
      },
      {
        metric: "batteryPct",
        label: "Electrical reserve",
        comparison: "at_least",
        target: 20,
        unit: "%",
      },
      {
        metric: "crewExposureMinutes",
        label: "Crew exposure",
        comparison: "at_most",
        target: 0,
        unit: "min",
      },
    ],
    title: "Solar Flare Warning",
    briefing:
      "An escalating solar flare will reach Mars in 22 minutes. An EVA crew is collecting samples, the primary communications path is vulnerable, and power must be reserved for radiation shelter systems.",
    minutesToImpact: 22,
    activeRisks: [
      "EVA crew is exposed",
      "Primary communications may be disrupted",
      "Shelter systems need protected reserve power",
    ],
    verification: {
      orbital:
        "Orbital radiation monitor confirms intensifying flux. Verification changes confidence, not the fixed response deadline.",
      maintenance:
        "Maintenance review: the backup relay can maintain low-rate emergency traffic from the shielded equipment bay.",
      crew: "EVA crew report: the rover is operational and can reach the radiation shelter route in approximately 11 minutes.",
    },
    availableActions: [
      "recall_eva",
      "shed_nonessential_load",
      "switch_to_backup_relay",
      "verify_orbital_weather",
    ],
    telemetry: [
      {
        label: "Radiation flux",
        value: "Rising 18%/min",
        status: "critical",
        detail: "Particle flux exceeds EVA exposure limits.",
      },
      {
        label: "EVA crew",
        value: "1 outside",
        status: "critical",
        detail: "Sample team is 2.7 km from the habitat.",
      },
      {
        label: "Backup relay",
        value: "Standby",
        status: "watch",
        detail: "Shielded relay is available for emergency traffic.",
      },
      {
        label: "Habitat battery",
        value: "66%",
        status: "watch",
        detail: "Shelter systems need a protected power reserve.",
      },
      {
        label: "Solar array",
        value: "Nominal",
        status: "watch",
        detail: "Array control may need to enter a protective orientation.",
      },
      {
        label: "Radiation shelter",
        value: "Ready",
        status: "nominal",
        detail: "Shielded habitat bay can support the crew through the flare peak.",
      },
    ],
  },
  rover_recovery: {
    id: "rover_recovery",
    initialConditions: initialConditions({
      batteryPct: 50,
      essentialLoad: 0.4,
      nonessentialLoad: 0.1,
      solarCharge: 0,
      crewOutside: 2,
      roverMobilityPct: 0,
      communicationsPct: 0,
      repairTarget: "rover",
      distanceToSafetyKm: 5,
    }),
    objectives: [
      {
        metric: "distanceToSafetyKm",
        label: "Crew at safety",
        comparison: "at_most",
        target: 0,
        unit: "km",
      },
      {
        metric: "crewOutside",
        label: "Crew sheltered",
        comparison: "at_most",
        target: 0,
        unit: "outside",
      },

      { metric: "wheelSlipPct", label: "Wheel slip", comparison: "at_most", target: 30, unit: "%" },

      {
        metric: "roverMobilityPct",
        label: "Rover mobility",
        comparison: "at_least",
        target: 70,
        unit: "%",
      },
      {
        metric: "communicationsPct",
        label: "Recovery communications",
        comparison: "at_least",
        target: 80,
        unit: "%",
      },
      {
        metric: "batteryPct",
        label: "Electrical reserve",
        comparison: "at_least",
        target: 20,
        unit: "%",
      },
      {
        metric: "crewExposureMinutes",
        label: "Crew exposure",
        comparison: "at_most",
        target: 0,
        unit: "min",
      },
    ],
    title: "Stranded Rover Recovery",
    briefing:
      "A science rover has lost traction in a shallow crater while two crew members are beyond line of sight. A repair drone can deploy a tow rig, but worsening dust may close the recovery window.",
    minutesToImpact: 27,
    activeRisks: [
      "Traverse crew is stranded",
      "Rover cannot climb out under its own power",
      "Dust will reduce recovery visibility",
    ],
    verification: {
      orbital:
        "Orbital terrain pass: the crater rim is stable, but the western exit route will become unsafe once visibility drops below 300 meters.",
      maintenance:
        "Maintenance review: the repair drone tow rig can stabilize the rover, but it needs a continuous relay link during deployment.",
      crew: "Traverse crew report: life support is nominal, but the rover's left drive wheel is spinning freely and cannot gain traction.",
    },
    availableActions: [
      "recall_eva",
      "deploy_repair_drone",
      "switch_to_backup_relay",
      "shed_nonessential_load",
      "verify_orbital_weather",
    ],
    telemetry: [
      {
        label: "Traverse crew",
        value: "2 in rover",
        status: "critical",
        detail: "Crew is stationary in the crater with beacon contact only.",
      },
      {
        label: "Repair drone",
        value: "Tow rig ready",
        status: "nominal",
        detail: "Tow line, anchors, and diagnostic arm are available.",
      },
      {
        label: "Backup relay",
        value: "Standby",
        status: "watch",
        detail: "Continuous recovery telemetry requires the backup path.",
      },
      {
        label: "Rover traction",
        value: "0% left drive",
        status: "critical",
        detail: "Wheel slip prevents ascent from the crater.",
      },
      {
        label: "Storm front",
        value: "27 min",
        status: "watch",
        detail: "Visibility is degrading on the western recovery route.",
      },
      {
        label: "Rover battery",
        value: "50%",
        status: "watch",
        detail: "Life support and recovery systems have enough reserve for the current window.",
      },
    ],
  },
};
