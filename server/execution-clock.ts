import {
  executionIntervalMs,
  executionTimingVersion,
  simulatedMinutesPerTick,
  type ExecutionPlayback,
} from "./mission-contract.js";
import { scenarios } from "./incident-scenarios.js";
import { objectiveResults } from "./simulation.js";
import { observeMissionTelemetry } from "./telemetry.js";
import { advanceMission } from "./mission.js";
import { MissionStore, type MissionRecord } from "./mission-store.js";

// The server owns simulation time. A missed deadline produces one tick, never downtime catch-up.
export class ExecutionClock {
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly store: MissionStore,
    private readonly locks: Set<string>,
    private readonly now = Date.now
  ) {
    store.restoreAll();
    for (const [key, record] of store.entries()) {
      if (record.state.phase !== "executing") continue;
      const restored = structuredClone(record);
      const previous = restored.execution;
      if (previous?.timingVersion !== executionTimingVersion) {
        // Preserve physical progress and custom targets; add missing crew-safety
        // goals/actions before an old execution can resume under the new rules.
        const current = scenarios[restored.state.scenario.id];
        for (const goal of current.objectives) {
          if (
            ["crewOutside", "distanceToSafetyKm"].includes(goal.metric) &&
            !restored.state.scenario.objectives.some((old) => old.metric === goal.metric)
          )
            restored.state.scenario.objectives.push(structuredClone(goal));
        }
        if (
          current.availableActions.includes("recall_eva") &&
          !restored.state.scenario.availableActions.includes("recall_eva")
        )
          restored.state.scenario.availableActions.push("recall_eva");
        if (restored.state.simulation.conditions.crewOutside === 0) {
          restored.state.simulation.conditions.crewReturnMinutes = 0;
          restored.state.simulation.conditions.distanceToSafetyKm = 0;
        }
        restored.state.recoveryStableSinceMinutes = undefined;
        restored.state.objectiveResults = objectiveResults(
          restored.state.simulation,
          restored.state.scenario.objectives
        );
        restored.state.telemetry = observeMissionTelemetry(
          restored.state.simulation,
          restored.state.scenario,
          restored.state.minutesToImpact,
          restored.state.telemetry
        );
      }
      restored.state.executionStartedAtMinutes ??= Math.max(
        0,
        restored.state.simulation.elapsedMinutes - restored.state.monitoringIntervals * 4
      );
      restored.execution =
        previous?.status === "running" && previous.timingVersion === executionTimingVersion
          ? this.running(previous.remainingMs ?? executionIntervalMs)
          : {
              status: "paused",
              timingVersion: executionTimingVersion,
              remainingMs: previous?.remainingMs ?? executionIntervalMs,
              message:
                previous?.message ??
                (!previous || previous.timingVersion !== executionTimingVersion
                  ? "Saved execution is paused. Review the updated crew-safety objectives and hazard-deadline rules before resuming."
                  : undefined),
            };
      store.save(key, restored);
    }
  }
  private running(delay = executionIntervalMs): ExecutionPlayback {
    return {
      status: "running",
      timingVersion: executionTimingVersion,
      nextTickAt: this.now() + Math.max(0, Math.min(executionIntervalMs, delay)),
    };
  }
  begin(): ExecutionPlayback {
    return this.running();
  }
  start() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const [key, record] of this.store.entries()) {
      if (record.execution?.status !== "running") continue;
      const saved = structuredClone(record);
      saved.execution!.remainingMs = Math.max(
        0,
        (record.execution.nextTickAt ?? this.now()) - this.now()
      );
      saved.execution!.nextTickAt = undefined;
      this.store.save(key, saved);
    }
  }
  playback(key: string, paused: boolean) {
    const record = structuredClone(this.store.load(key));
    if (record.state.phase !== "executing")
      throw new Error("Playback controls are available only while a plan is executing.");
    if (paused && record.execution?.status === "running") {
      record.execution = {
        status: "paused",
        timingVersion: executionTimingVersion,
        remainingMs: Math.max(0, (record.execution.nextTickAt ?? this.now()) - this.now()),
      };
    } else if (!paused && record.execution?.status !== "running") {
      record.execution = this.running(record.execution?.remainingMs ?? executionIntervalMs);
    }
    this.store.save(key, record);
    return record;
  }
  step(key: string) {
    const record = this.store.load(key);
    if (record.state.phase !== "executing" || record.execution?.status !== "paused")
      throw new Error("Pause accelerated simulation before stepping manually.");
    return this.advance(key, record, false);
  }
  private advance(key: string, record: MissionRecord, automatic: boolean) {
    // Commit physical conditions and the next deadline together, before changing cached state.
    const next = structuredClone(record);
    next.state = advanceMission(next.state, automatic ? simulatedMinutesPerTick : undefined);
    next.execution =
      next.state.phase !== "executing"
        ? { status: "stopped", timingVersion: executionTimingVersion }
        : automatic
          ? this.running()
          : {
              status: "paused",
              timingVersion: executionTimingVersion,
              remainingMs: executionIntervalMs,
            };
    this.store.save(key, next);
    return next;
  }
  tick() {
    for (const [key, record] of this.store.entries()) {
      if (
        this.locks.has(key) ||
        record.state.phase !== "executing" ||
        record.execution?.status !== "running"
      )
        continue;
      if ((record.execution.nextTickAt ?? Infinity) > this.now()) continue;
      try {
        this.advance(key, record, true);
      } catch {
        // Preserve the last durable conditions and stop instead of silently running without storage.
        record.execution = {
          status: "paused",
          timingVersion: executionTimingVersion,
          remainingMs: executionIntervalMs,
          message:
            "Execution paused because mission progress could not be saved. Restore storage before resuming.",
        };
      }
    }
  }
}
