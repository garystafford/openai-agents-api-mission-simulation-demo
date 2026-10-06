import type { ObjectiveResult, InitialConditions } from "./simulation.js";

export const missionRulesVersion = 3;
export const missionRules = {
  version: missionRulesVersion,
  success:
    "Observe through the hazard deadline. Every objective must be met continuously for the final 60 simulated seconds, with all authorized actions complete. The interval ends at the original deadline: for deadline D it is D−1 through D, never D through D+1. Later sensitivity forecasts do not extend confirmation. Earlier recovery alone is not final success.",
  reserve:
    "Battery reserve and power endurance are acceptance targets, not execution interlocks. A reserve shortfall cannot count as full success but does not stop a powered rescue. Actual battery exhaustion and irreversible crew safety violations stop execution.",
  endurance:
    "Power endurance is battery divided by current net draw, in minutes to empty, not time to the reserve floor and not a required mission duration. Name the observation time in every projection.",
  crew: "Crew return estimates apply only while crew are outside. recall_eva must be explicitly included in the initial proposal; it waits for at least 50% mobility. Use the published incident-specific recallPrerequisites for the communications gate. Only stranded-rover recovery requires an 80% link; ordinary EVA recall, including the relay-failure and solar-flare incidents, does not. Mentioning a rover or rover mobility does not establish that gate. Repair alone does not return crew. Guided return decrements remaining travel time and distance together; arrival sets crew outside and distance to zero.",
  exposure:
    "Crew exposure minutes accumulate while crew are outside after hazard arrival, or whenever air processing is below 30%, including inside crew. Minutes outside before arrival are not automatically hazardous exposure. Radiation dose accumulates separately before and after arrival; shelter attenuates dose only while inside, and cannot erase prior dose.",
  timing:
    "The commander authorizes one proposal containing one to four commands together. The Director proposes and specialists recommend; neither grants authorization. If outside crew need recall, include it in that initial authorization, even when its work must wait. Authorized commands start together, wait for prerequisites, and use elapsed simulated time. Do not request a separate later authorization merely to begin prerequisite-gated work. Do not add a fifth informational action to a four-command rescue. List order does not schedule commands. Weather verification raises confidence only; it never moves the fixed hazard deadline.",
  electrical:
    "Battery percentage points per minute: essential plus nonessential draw, plus 0.15 once the backup relay is online, minus solar charge. Shedding removes nonessential draw only after four minutes. Drone work costs 1.5 per working minute, twelve total, on top of other loads; no repair draw accrues while waiting for prerequisites.",
  repair:
    "An eight-working-minute internal coolant repair restores coolant quantity to 95% and stops leakage; it has no communications prerequisite. Rover repair needs at least 80% communications and restores mobility to 85% (wheel slip 15%). Both require sufficient actual battery. Temperature recovery follows measured cooling dynamics; it is not instantaneous.",
  coolant:
    "Coolant percentage is available coolant quantity relative to nominal, not pressure. Flow equals coolant percentage times 0.12 L/min. Coolant leakage is percentage points per minute.",
};

export function hardSafetyFailure(conditions: InitialConditions, goals: ObjectiveResult[]) {
  if (conditions.batteryPct <= 0) return "Actual electrical power exhausted.";
  const irreversible = goals.filter(
    (goal) => !goal.met && ["crewExposureMinutes", "crewDoseMsv"].includes(goal.metric)
  );
  return irreversible.length
    ? "An irreversible crew safety limit was exceeded: " +
        irreversible.map((goal) => goal.label).join(", ") +
        "."
    : undefined;
}
