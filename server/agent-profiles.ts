import "./env.js";

import type { SpecialistName } from "./mission-team.js";

export type AgentProfileName = "Mission Director" | SpecialistName;
const reasoningEfforts = ["none", "low", "medium", "high", "xhigh", "max"] as const;
type ReasoningEffort = (typeof reasoningEfforts)[number];
type AgentProfile = { model: string; reasoningEffort: ReasoningEffort };
export type PublicAgentProfile = Pick<AgentProfile, "model" | "reasoningEffort">;

export const DEFAULT_AGENT_MODEL = "gpt-6-luna";
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

function configuredModel(variable: string, fallback: string) {
  return process.env[variable]?.trim() || fallback;
}

function configuredReasoningEffort(variable: string, fallback: ReasoningEffort): ReasoningEffort {
  const value = process.env[variable]?.trim().toLowerCase();
  return reasoningEfforts.includes(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : fallback;
}

function profile(
  prefix: string,
  fallback = DEFAULT_AGENT_MODEL,
  effort = DEFAULT_REASONING_EFFORT,
  legacyPrefix?: string
): AgentProfile {
  return {
    model: configuredModel(
      prefix + "_MODEL",
      legacyPrefix ? configuredModel(legacyPrefix + "_MODEL", fallback) : fallback
    ),
    reasoningEffort: configuredReasoningEffort(
      prefix + "_REASONING_EFFORT",
      legacyPrefix ? configuredReasoningEffort(legacyPrefix + "_REASONING_EFFORT", effort) : effort
    ),
  };
}

export const agentProfiles: Record<AgentProfileName, AgentProfile> = {
  "Mission Director": profile("MISSION_DIRECTOR"),
  "Power & Thermal": profile("POWER_THERMAL", "gpt-6-astra", undefined, "NOVA"),
  "Life Support": profile("LIFE_SUPPORT", undefined, undefined, "AURA"),
  "Weather & Navigation": profile("WEATHER_NAVIGATION", undefined, undefined, "KEPLER"),
  "Risk Review": profile("RISK_REVIEW", "gpt-6-astra", undefined, "MERCURY"),
};

export const publicAgentProfiles: Record<AgentProfileName, PublicAgentProfile> = Object.fromEntries(
  Object.entries(agentProfiles).map(([name, profile]) => [
    name,
    { model: profile.model, reasoningEffort: profile.reasoningEffort },
  ])
) as Record<AgentProfileName, PublicAgentProfile>;
