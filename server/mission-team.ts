export const specialistNames = [
  "Power & Thermal",
  "Life Support",
  "Weather & Navigation",
  "Risk Review",
] as const;
export type SpecialistName = (typeof specialistNames)[number];

export const missionTeam = [
  {
    name: "Power & Thermal",
    mark: "power-thermal",
    role: "Power & Thermal",
    focus: "Protects solar, battery, and habitat heat reserves.",
  },
  {
    name: "Life Support",
    mark: "life-support",
    role: "Life Support",
    focus: "Keeps the cabin air safe and the scrubber loop stable.",
  },
  {
    name: "Weather & Navigation",
    mark: "weather-navigation",
    role: "Weather & Navigation",
    focus: "Forecasts conditions and brings field crews home.",
  },
  {
    name: "Risk Review",
    mark: "risk-review",
    role: "Risk Review",
    focus: "Challenges weak assumptions and unsafe trade-offs.",
  },
] satisfies Array<{ name: SpecialistName; role: string; mark: string; focus: string }>;

// Translate saved pre-rename identities without changing hosted session IDs or plans.
export const legacySpecialistNames = {
  NOVA: "Power & Thermal",
  AURA: "Life Support",
  KEPLER: "Weather & Navigation",
  MERCURY: "Risk Review",
} as const satisfies Record<string, SpecialistName>;

export function specialistName(name: string): string {
  return Object.hasOwn(legacySpecialistNames, name)
    ? legacySpecialistNames[name as keyof typeof legacySpecialistNames]
    : name;
}
