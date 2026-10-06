// Offline browser fixture: no provider calls, keys, or production mission storage.
import express from "express";
import { randomUUID } from "node:crypto";
import { createMissionApp } from "../server/app.js";
import { accessConfig } from "../server/access.js";
import { MissionUsageCollector } from "../server/mission-usage.js";
import type { MissionRuntime } from "../server/mission-assessment.js";
import type { DecisionPlan, MissionState, MissionAction } from "../server/mission-contract.js";
import { actionLabels } from "../server/mission-contract.js";
import { testPlan } from "./fixtures.js";
import type { ExecutionClock } from "../server/execution-clock.js";
import type { MissionAssessment } from "../server/mission-assessment.js";
import { missionTeam } from "../server/mission-team.js";
const pending = new Map<string, { id: string; plan: DecisionPlan }>();
const actions: Record<MissionState["scenario"]["id"], MissionAction[]> = {
  dust_storm: ["recall_eva", "isolate_scrubber", "shed_nonessential_load"],
  coolant_leak: ["deploy_repair_drone", "shed_nonessential_load"],
  relay_failure: ["switch_to_backup_relay", "shed_nonessential_load", "recall_eva"],
  solar_flare: ["recall_eva", "switch_to_backup_relay", "shed_nonessential_load"],
  rover_recovery: [
    "recall_eva",
    "switch_to_backup_relay",
    "deploy_repair_drone",
    "shed_nonessential_load",
  ],
};
const runtime = {
  clearMissionSession: async (id: string) => {
    pending.delete(id);
  },
  pendingMissionApproval: (id: string) => pending.get(id),
  runMissionDirector: async (
    state: MissionState,
    onActivity: Parameters<MissionRuntime["runMissionDirector"]>[1],
    onReport: Parameters<MissionRuntime["runMissionDirector"]>[2],
    reviewRequest?: string
  ) => {
    const plan = structuredClone(state.selectedPlan ?? testPlan(actions[state.scenario.id]));
    if (reviewRequest === "What happens if the backup relay never comes online?") {
      plan.headline = "Plan clarification";
      plan.rationale =
        "The drone waits for communications. If the relay never recovers, repair cannot progress; the current plan is unchanged and still needs your authorization.";
    } else if (reviewRequest === "Add an orbital weather cross-check to the plan.") {
      if (!state.scenario.availableActions.includes("verify_orbital_weather"))
        throw new Error("The test incident does not support a weather cross-check.");
      plan.headline = "Revised test response";
      plan.actions = [...new Set([...plan.actions, "verify_orbital_weather" as const])];
      plan.rationale = "Added the requested orbital weather cross-check to the response.";
      plan.approvalScope =
        "Authorize these fictional simulator commands: " +
        plan.actions.map((action) => actionLabels[action]).join("; ");
    }
    const proposal = { id: randomUUID(), plan };
    pending.set(state.missionId, proposal);
    const reports = missionTeam.map((member) => ({
      agent: member.name,
      role: member.role,
      status: "watch" as const,
      confidence: 0.8,
      recommendation: "Offline fixture assessment for " + member.name + ".",
      evidence: ["Scripted browser-test observation"],
      tradeoff: "Synthetic test advice",
    }));
    const log = reports.map((report) => ({
      id: randomUUID(),
      speaker: report.agent,
      kind: "evidence" as const,
      message: "Requested the latest mission telemetry.",
    }));
    for (const entry of log) onActivity?.(entry);
    for (const report of reports) onReport?.(report);
    return {
      plan,
      proposalId: proposal.id,
      log,
      reports,
      usage: new MissionUsageCollector().summary(),
      awaitingApproval: true,
    };
  },
  resolveMissionApproval: async (state: MissionState, _approved: boolean, id: string) => {
    if (pending.get(state.missionId)?.id !== id) throw new Error("Stale test proposal");
    pending.delete(state.missionId);
    return { awaitingApproval: false, usage: new MissionUsageCollector().summary() };
  },
} as unknown as MissionRuntime;
const app = createMissionApp(runtime, accessConfig({ PORT: "3011" }));
app.use(express.static("dist"));
const clock = app.locals.executionClock as ExecutionClock;
const assessment = app.locals.missionAssessment as MissionAssessment;
clock.start();
assessment.start();
const server = app.listen(3011, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    assessment.stop();
    clock.stop();
    server.close();
  });
