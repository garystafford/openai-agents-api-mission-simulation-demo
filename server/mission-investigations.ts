import OpenAI from "openai";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DurableJson } from "./durable-json.js";
import { ownerKey } from "./mission-store.js";
import { AgentsApi, type FunctionCall, type SessionRef, type ToolResult } from "./agents-api.js";
import { MissionUsageCollector } from "./mission-usage.js";
import { MissionSessions } from "./mission-sessions.js";
import type { DecisionPlan } from "./mission-contract.js";

type PendingApproval = { id: string; call: FunctionCall; plan: DecisionPlan };
export type Investigation = {
  api: AgentsApi;
  usage: MissionUsageCollector;
  director: SessionRef;
  sessions: MissionSessions;
  mcp?: Client;
  pending?: PendingApproval;
  restored?: boolean;
  legacyEvidence?: boolean;
};
const investigations = new Map<string, Investigation>();
type InvestigationSnapshot = {
  version: 1;
  evidenceVersion?: number;
  refs: Array<Omit<SessionRef, "results"> & { results: Array<[string, ToolResult]> }>;
  usage: ReturnType<MissionUsageCollector["snapshot"]>;
  pending?: PendingApproval;
};
let agentStorage = new DurableJson<InvestigationSnapshot>();
export function configureAgentStorage(directory: string) {
  agentStorage = new DurableJson(directory);
}
export function checkpointInvestigation(missionId: string) {
  const investigation = investigations.get(missionId);
  if (!investigation) return;
  agentStorage.set(ownerKey(missionId), {
    version: 1,
    evidenceVersion: 2,
    refs: investigation.sessions.all().map((ref) => ({ ...ref, results: [...ref.results] })),
    usage: investigation.usage.snapshot(),
    pending: investigation.pending,
  });
}
export function investigationFor(missionId: string): Investigation | undefined {
  const existing = investigations.get(missionId);
  if (existing) return existing;
  const saved = agentStorage.get(ownerKey(missionId));
  if (!saved) return;
  if (saved.version !== 1) throw new Error("Unsupported saved agent state.");
  return createInvestigation(missionId, saved);
}

export function createInvestigation(
  missionId: string,
  saved?: InvestigationSnapshot
): Investigation {
  const usage = new MissionUsageCollector();
  if (saved) usage.restore(saved.usage);
  const api = new AgentsApi(new OpenAI({ maxRetries: 0, timeout: 180000 }), usage, () =>
    checkpointInvestigation(missionId)
  );
  const sessions = new MissionSessions(
    missionId,
    api,
    saved?.refs.map((ref) => ({ ...ref, results: new Map(ref.results) }))
  );
  const investigation: Investigation = {
    api,
    usage,
    sessions,
    director: sessions.ref("Mission Director"),
    pending: saved?.pending,
    restored: Boolean(saved),
    legacyEvidence: Boolean(saved && saved.evidenceVersion !== 2),
  };
  investigations.set(missionId, investigation);
  return investigation;
}
// Shutdown retains hosted history and pending proposals. In-flight operations
// are marked interrupted by the mission store on startup; commands never replay.
export async function suspendMissionSessions() {
  for (const [id, investigation] of investigations) {
    checkpointInvestigation(id);
    if (!investigation.pending)
      await Promise.allSettled(
        investigation.sessions.all().map((ref) => investigation.api.cancel(ref))
      );
    await investigation.mcp?.close();
  }
}

export function pendingMissionApproval(missionId: string) {
  const pending = investigationFor(missionId)?.pending;
  return pending && !investigationFor(missionId)?.legacyEvidence
    ? { id: pending.id, plan: structuredClone(pending.plan) }
    : undefined;
}
export async function clearMissionSession(missionId: string) {
  const investigation = investigationFor(missionId);
  if (!investigation) return;
  investigation.pending = undefined;
  const refs = investigation.sessions.all();
  const cleanup = await Promise.allSettled(refs.map((ref) => investigation.api.dispose(ref)));
  const errors = cleanup.flatMap((result, i) => (result.status === "rejected" ? [refs[i].id] : []));
  await investigation.mcp?.close();
  investigation.mcp = undefined;
  if (errors.length) throw new Error("Remote session cleanup needs a retry: " + errors.join(", "));
  investigations.delete(missionId);
  agentStorage.delete(ownerKey(missionId));
}
export async function missionUsage(missionId: string) {
  const current = investigationFor(missionId);
  return current ? collectUsage(current) : undefined;
}

export async function collectUsage(investigation: Investigation) {
  try {
    await investigation.api.refreshUsage(investigation.sessions.all());
    return investigation.usage.summary();
  } catch {
    // Accounting outages must not invalidate a completed assessment/decision.
    return {
      ...investigation.usage.summary(),
      accountingPending: true,
      estimatedCostUsd: undefined,
    };
  }
}
