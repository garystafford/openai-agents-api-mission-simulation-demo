// Public mission data shared by the HTTP API and browser. Runtime imports here
// must stay free of server configuration, credentials, and provider clients.
import type { InvestigationMetrics } from "./investigation-budget.js";
import type { InitialConditions, Objective, ObjectiveResult, Simulation } from "./simulation.js";
import type { TelemetrySample } from "./telemetry.js";

export type SystemStatus = "nominal" | "watch" | "critical";

export type SystemReading = {
  label: string;
  value: string;
  status: SystemStatus;
  detail: string;
  sampledAtMinutes?: number;
  numericValue?: number;
  quality?: "current" | "delayed";
  metric?: keyof import("./simulation.js").Conditions;
  unit?: string;
  trend?: "rising" | "falling" | "steady" | "insufficient_data";
  history?: TelemetrySample[];
};

export const missionActions = [
  "recall_eva",
  "shed_nonessential_load",
  "isolate_scrubber",
  "verify_orbital_weather",
  "deploy_repair_drone",
  "switch_to_backup_relay",
] as const;

export type MissionAction = (typeof missionActions)[number];

export const actionLabels: Record<MissionAction, string> = {
  recall_eva: "Recall EVA crew and activate rover guidance",
  shed_nonessential_load: "Shed greenhouse and laboratory power",
  isolate_scrubber: "Isolate the unstable scrubber loop",
  verify_orbital_weather: "Request an orbital weather cross-check",
  deploy_repair_drone: "Deploy the exterior repair drone",
  switch_to_backup_relay: "Switch to the backup communications relay",
};

export type SpecialistReport = {
  agent: string;
  role: string;
  status: SystemStatus;
  confidence: number;
  recommendation: string;
  evidence: string[];
  tradeoff: string;
};

export type CouncilLog = {
  id: string;
  speaker: string;
  message: string;
  kind: "director" | "evidence" | "assessment" | "api";
};

export type DecisionPlan = {
  headline: string;
  actions: MissionAction[];
  rationale: string;
  uncertainties: string[];
  approvalScope: string;
};

export type ModelUsage = {
  model: string;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  visibleOutputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
};

export type MissionUsage = {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  visibleOutputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  accountingPending?: boolean;
  unpricedModels: string[];
  byModel: ModelUsage[];
  knownEstimatedCostUsd?: number;
};

export type IncidentScenario = {
  id: "dust_storm" | "coolant_leak" | "relay_failure" | "solar_flare" | "rover_recovery";
  title: string;
  briefing: string;
  minutesToImpact: number;
  activeRisks: string[];
  verification: Record<string, string>;
  initialConditions: InitialConditions;
  objectives: Objective[];
  availableActions: MissionAction[];
  telemetry: SystemReading[];
};

export type MissionEvent = {
  time: string;
  event: string;
  kind: "system" | "agent" | "approval";
  occurredAt?: string;
  simulatedAtMinutes?: number;
  plan?: DecisionPlan;
  proposalId?: string;
  objectives?: ObjectiveResult[];
};

export type MissionState = {
  missionId: string;
  sol: number;
  variation?: import("./incident-variation.js").IncidentOptions;
  minutesToImpact: number;
  monitoringIntervals: number;
  executionStartedAtMinutes?: number;
  recoveryStableSinceMinutes?: number;
  lastExecutionProgressAtMinutes?: number;
  replanning?: {
    attempts: number;
    status: "queued" | "running" | "ready" | "limit" | "error" | "interrupted";
    reason: string;
  };
  phase: "alert" | "assessment" | "approval_required" | "executing" | "resolved" | "failed";
  scenario: IncidentScenario;
  telemetry: SystemReading[];
  simulation: Simulation;
  objectiveResults: ObjectiveResult[];
  reports: SpecialistReport[];
  councilLog: CouncilLog[];
  timeline: MissionEvent[];
  usage?: MissionUsage;
  investigation?: InvestigationMetrics;
  proposalId?: string;
  pendingCommand?: { id: string; label: string; consequence: string };
  selectedPlan?: DecisionPlan;
  outcome?: "stabilized" | "degraded" | "failed";
  failureReason?: string;
};

export type MissionOperation = {
  kind: "assessment" | "approval" | "reset";
  status: "running" | "complete" | "interrupted" | "error";
  startedAt: number;
  message?: string;
};

export const executionIntervalMs = 1000;
export const simulationSpeed = 48;
export const simulatedMinutesPerTick = (simulationSpeed * executionIntervalMs) / 60000;
export const monitoringIntervalMinutes = 4;
export const minimumObservationMinutes = 12;
export const executionTimingVersion = 4;
export const recoveryConfirmationSeconds = 60;
export const maximumAutomaticReplans = 2;
export const stalledExecutionSeconds = 180;

export function formatSimulationTime(minutes: number, roundUp = false) {
  const seconds = Math.max(
    0,
    roundUp ? Math.ceil(minutes * 60 - 1e-8) : Math.floor(minutes * 60 + 1e-8)
  );
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
export type ExecutionPlayback = {
  timingVersion?: number;
  status: "running" | "paused" | "stopped";
  nextTickAt?: number;
  remainingMs?: number;
  message?: string;
};

export type MissionResponse = MissionState & {
  operation?: MissionOperation;
  execution?: ExecutionPlayback;
  agentProfiles: Record<string, { model: string; reasoningEffort: string }>;
};

export type AssessmentEvent =
  | { type: "activity"; entry: CouncilLog }
  | { type: "report"; report: SpecialistReport }
  | { type: "complete"; plan: DecisionPlan; state: MissionResponse }
  | { type: "error"; message: string };
