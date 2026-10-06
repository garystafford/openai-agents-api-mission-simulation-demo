import { publicAgentProfiles } from "./agent-profiles.js";
import type { MissionState } from "./mission-contract.js";
import type * as missionAgents from "./agents.js";
import { missionEvent } from "./mission-events.js";
import { InvestigationError } from "./investigation-budget.js";
import { maximumAutomaticReplans, type AssessmentEvent } from "./mission-contract.js";
import type { MissionStore } from "./mission-store.js";

export type MissionRuntime = Pick<
  typeof missionAgents,
  "clearMissionSession" | "pendingMissionApproval" | "resolveMissionApproval" | "runMissionDirector"
>;
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Mission operation failed.";

// A durable queue launches planning only. It never grants execution authority.
export class MissionAssessment {
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  constructor(
    private readonly store: MissionStore,
    private readonly locks: Set<string>,
    private readonly runtime: MissionRuntime
  ) {}
  start() {
    this.stopping = false;
    this.timer ??= setInterval(() => this.tick(), 250);
    this.timer.unref();
  }
  stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }
  tick() {
    if (this.stopping) return;
    for (const [key, record] of this.store.entries()) {
      if (
        record.state.phase !== "assessment" ||
        record.state.replanning?.status !== "queued" ||
        this.locks.has(key)
      )
        continue;
      void this.run(key, record.state.replanning.reason, undefined, true).catch(() => {});
    }
  }
  async run(
    key: string,
    reviewRequest?: string,
    send: (event: AssessmentEvent) => void = () => {},
    automatic = false
  ) {
    if (this.stopping || this.locks.has(key))
      throw new Error("A mission operation is in progress.");
    const record = this.store.load(key);
    if (["executing", "resolved", "failed"].includes(record.state.phase))
      throw new Error("This mission is not available for assessment.");
    if (automatic && (record.state.replanning?.attempts ?? 0) >= maximumAutomaticReplans) {
      record.state.replanning = { ...record.state.replanning!, status: "limit" };
      this.store.save(key, record);
      return;
    }
    this.locks.add(key);
    try {
      const snapshot = structuredClone(record.state);
      const mission: MissionState = {
        ...record.state,
        phase: "assessment" as const,
        reports: [],
        councilLog: [],
        pendingCommand: undefined,
        proposalId: undefined,
        selectedPlan: undefined,
      };
      if (mission.replanning)
        mission.replanning = {
          ...mission.replanning,
          attempts: mission.replanning.attempts + (automatic ? 1 : 0),
          status: "running",
        };
      record.state = mission;
      record.operation = { kind: "assessment", status: "running", startedAt: Date.now() };
      mission.timeline.push(
        missionEvent(mission, {
          kind: "agent",
          event: automatic
            ? "Execution feedback automatically requested a revised plan: " + reviewRequest
            : reviewRequest
              ? "Commander requested a plan review: " + reviewRequest
              : "Mission Director began an adaptive investigation.",
        })
      );
      this.store.save(key, record);
      const result = await this.runtime.runMissionDirector(
        snapshot,
        (entry) => {
          mission.councilLog.push(entry);
          this.store.save(key, record);
          send({ type: "activity", entry });
        },
        (report) => {
          mission.reports = [
            ...mission.reports.filter((previous) => previous.agent !== report.agent),
            report,
          ];
          this.store.save(key, record);
          send({ type: "report", report });
        },
        reviewRequest
      );
      record.state = {
        ...mission,
        councilLog: result.log,
        reports: result.reports,
        usage: result.usage,
        investigation: result.investigation,
        selectedPlan: result.plan,
        proposalId: result.proposalId,
      };
      if (record.state.replanning) record.state.replanning.status = "ready";
      record.state.timeline.push(
        missionEvent(record.state, {
          event: automatic
            ? "Revised proposal ready for commander review. No new actions dispatched."
            : "Mission Director completed the team decision brief.",
          kind: "agent",
          plan: result.plan,
          proposalId: result.proposalId,
        })
      );
      record.operation.status = "complete";
      this.store.save(key, record);
      send({
        type: "complete",
        plan: result.plan,
        state: {
          ...record.state,
          operation: record.operation,
          execution: record.execution,
          agentProfiles: publicAgentProfiles,
        },
      });
    } catch (error) {
      if (error instanceof InvestigationError) {
        record.state.investigation = error.investigation;
        record.state.usage = error.usage;
      }
      if (record.state.replanning) record.state.replanning.status = "error";
      record.operation = {
        kind: "assessment",
        status: "error",
        startedAt: record.operation?.startedAt ?? Date.now(),
        message: errorMessage(error),
      };
      record.state.timeline.push(
        missionEvent(record.state, {
          kind: "system",
          event: "Assessment stopped without dispatching actions: " + errorMessage(error),
        })
      );
      this.store.save(key, record);
      throw error;
    } finally {
      this.locks.delete(key);
    }
  }
}
