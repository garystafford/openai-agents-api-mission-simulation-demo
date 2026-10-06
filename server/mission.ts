import {
  configureIncident,
  incidentDisturbances,
  type IncidentOptions,
} from "./incident-variation.js";
import { missionEvent } from "./mission-events.js";
import { validateMissionPlan } from "./agent-schemas.js";
import { randomUUID } from "node:crypto";
import {
  beginExecution,
  createSimulation,
  objectiveResults,
  stepSimulation,
} from "./simulation.js";

import { hardSafetyFailure } from "./mission-rules.js";
import { observeMissionTelemetry } from "./telemetry.js";

import {
  actionLabels,
  monitoringIntervalMinutes,
  minimumObservationMinutes,
  recoveryConfirmationSeconds,
  stalledExecutionSeconds,
  type DecisionPlan,
  type IncidentScenario,
  type MissionState,
} from "./mission-contract.js";
import { scenarioIds, scenarios } from "./incident-scenarios.js";
export { actionLabels, missionActions } from "./mission-contract.js";
export type {
  SystemStatus,
  SystemReading,
  MissionAction,
  SpecialistReport,
  CouncilLog,
  DecisionPlan,
  ModelUsage,
  MissionUsage,
  IncidentScenario,
  MissionState,
} from "./mission-contract.js";
export { scenarioIds } from "./incident-scenarios.js";

export function createMission(
  scenarioId: IncidentScenario["id"] = "dust_storm",
  options?: IncidentOptions
): MissionState {
  const scenario = structuredClone(scenarios[scenarioId]);
  if (options) configureIncident(scenario, options);
  const simulation = createSimulation(scenario.initialConditions);
  if (options) simulation.disturbances = incidentDisturbances(options);
  if (options?.profile === "delayed_sensors") simulation.sensorDelaySeconds = 96;
  return {
    missionId: "ares-7-" + randomUUID(),
    sol: 184,
    ...(options ? { variation: options } : {}),
    minutesToImpact: scenario.minutesToImpact,
    monitoringIntervals: 0,
    phase: "alert",
    scenario,
    telemetry: observeMissionTelemetry(simulation, scenario, scenario.minutesToImpact),
    simulation,
    objectiveResults: objectiveResults(simulation, scenario.objectives),
    reports: [],
    councilLog: [],
    timeline: [
      missionEvent(
        { simulation },
        { event: "Ares-7 detects: " + scenario.title + ".", kind: "system" }
      ),
      missionEvent({ simulation }, { event: scenario.briefing, kind: "system" }),
    ],
  };
}

export function randomScenarioId(exclude?: IncidentScenario["id"]): IncidentScenario["id"] {
  const choices = scenarioIds.filter((id) => id !== exclude);
  return choices[Math.floor(Math.random() * choices.length)] ?? scenarioIds[0];
}

export function requestCommand(state: MissionState, planInput: DecisionPlan): MissionState {
  const next = structuredClone(state);
  const plan = validateMissionPlan(next, planInput);
  next.phase = "approval_required";
  next.selectedPlan = plan;
  next.pendingCommand = {
    id: "cmd-" + plan.actions.join("-"),
    label: plan.actions.map((action) => actionLabels[action]).join(" + "),
    consequence: plan.approvalScope,
  };
  next.timeline.push(
    missionEvent(next, {
      event:
        "Mission Director requests commander authorization for: " +
        plan.actions.map((action) => actionLabels[action]).join("; ") +
        ".",
      kind: "approval",
      plan,
      proposalId: next.proposalId,
    })
  );
  return next;
}

export function approveCommand(state: MissionState, approved: boolean): MissionState {
  const next = structuredClone(state);
  const plan = next.selectedPlan;
  if (!next.pendingCommand || !plan) throw new Error("No command is awaiting authorization.");
  next.pendingCommand = undefined;
  if (!approved) {
    next.phase = "assessment";
    next.timeline.push(
      missionEvent(next, {
        event:
          "Commander withheld authorization. The Mission Director must investigate an alternative.",
        kind: "approval",
        plan,
        proposalId: next.proposalId,
      })
    );
    return next;
  }

  const actions = plan.actions;
  next.phase = "executing";
  next.monitoringIntervals = 0;
  next.executionStartedAtMinutes = next.simulation.elapsedMinutes;
  next.outcome = undefined;
  next.recoveryStableSinceMinutes = undefined;
  next.lastExecutionProgressAtMinutes = next.simulation.elapsedMinutes;
  next.simulation = beginExecution(next.simulation, actions);
  next.timeline.push(
    missionEvent(next, {
      event:
        "Commander authorized: " + actions.map((action) => actionLabels[action]).join("; ") + ".",
      kind: "approval",
      plan,
      proposalId: next.proposalId,
    })
  );
  next.timeline.push(
    missionEvent(next, {
      event:
        "Actions dispatched. Mission Control is monitoring their effect before confirming the outcome.",
      kind: "system",
    })
  );
  return next;
}

function queueReassessment(next: MissionState, reason: string) {
  next.phase = "assessment";
  next.outcome = "degraded";
  next.recoveryStableSinceMinutes = undefined;
  next.replanning = { attempts: next.replanning?.attempts ?? 0, status: "queued", reason };
  for (const command of next.simulation.commands) {
    if (command.status === "pending" || command.status === "running") {
      command.status = "failed";
      command.detail = "Stopped pending a revised plan and new commander authorization.";
    }
  }
  next.timeline.push(
    missionEvent(next, {
      event:
        reason +
        " Execution stopped; requesting a revised proposal. New actions require human authorization.",
      kind: "system",
      objectives: next.objectiveResults,
    })
  );
}

function evaluateOutcome(next: MissionState, previous: MissionState["objectiveResults"]) {
  const unmet = next.objectiveResults.filter((objective) => !objective.met);
  const active = next.simulation.commands.filter(
    (command) => command.status === "pending" || command.status === "running"
  );
  if (unmet.length || next.simulation.commands.some((command) => command.status !== "succeeded"))
    next.recoveryStableSinceMinutes = undefined;
  else next.recoveryStableSinceMinutes ??= next.simulation.elapsedMinutes;
  const confirmed =
    next.recoveryStableSinceMinutes !== undefined &&
    (next.simulation.elapsedMinutes - next.recoveryStableSinceMinutes) * 60 >=
      recoveryConfirmationSeconds - 1e-8;
  const responseMinutes = next.simulation.elapsedMinutes - (next.executionStartedAtMinutes ?? 0);
  const verificationDue = responseMinutes >= minimumObservationMinutes - 1e-8;
  const hardFailure = hardSafetyFailure(next.simulation.conditions, next.objectiveResults);
  const recovering =
    unmet.filter((goal) => !["batteryPct", "powerEnduranceMinutes"].includes(goal.metric)).length >
      0 &&
    unmet
      .filter((goal) => !["batteryPct", "powerEnduranceMinutes"].includes(goal.metric))
      .every((goal) => {
        const prior = previous.find((item) => item.metric === goal.metric);
        return (
          prior &&
          (goal.comparison === "at_least"
            ? goal.actual > prior.actual + 1e-8
            : goal.actual < prior.actual - 1e-8)
        );
      });
  if (hardFailure || (next.minutesToImpact === 0 && (!confirmed || unmet.length > 0))) {
    next.phase = "failed";
    next.outcome = "failed";
    next.failureReason =
      hardFailure ??
      "The response window expired before stable recovery was confirmed. Unmet objectives: " +
        (unmet.map((goal) => goal.label).join(", ") || "final confirmation period incomplete") +
        ".";
    for (const command of active) {
      command.status = "failed";
      command.detail = "Stopped at the mission failure boundary.";
    }
    next.timeline.push(
      missionEvent(next, {
        event: next.failureReason,
        objectives: next.objectiveResults,
        kind: "system",
      })
    );
  } else if (next.simulation.commands.some((command) => command.status === "failed")) {
    queueReassessment(
      next,
      "An authorized action failed. Review execution results and current observations."
    );
  } else if (
    active.length &&
    (next.simulation.elapsedMinutes -
      (next.lastExecutionProgressAtMinutes ?? next.executionStartedAtMinutes ?? 0)) *
      60 >=
      stalledExecutionSeconds - 1e-8
  ) {
    queueReassessment(
      next,
      "Authorized actions made no progress for three simulated minutes. Investigate their prerequisites."
    );
  } else if (next.minutesToImpact === 0) {
    next.outcome = "stabilized";
    next.phase = "resolved";
    next.timeline.push(
      missionEvent(next, {
        event:
          "Measured mission conditions met every objective for the final recovery confirmation period through the hazard deadline. The response is stable.",
        kind: "system",
        objectives: next.objectiveResults,
      })
    );
  } else if (
    !active.length &&
    verificationDue &&
    !recovering &&
    unmet.some((goal) => !["batteryPct", "powerEnduranceMinutes"].includes(goal.metric))
  ) {
    queueReassessment(
      next,
      "The response did not meet mission objectives: " +
        unmet.map((goal) => goal.label).join(", ") +
        "."
    );
  }
}

export function advanceMission(
  state: MissionState,
  minutes = monitoringIntervalMinutes
): MissionState {
  const next = structuredClone(state);
  if (next.phase !== "executing") return next;
  const seconds = Math.max(0, Math.round(minutes * 60));
  for (let second = 0; second < seconds && next.phase === "executing"; second++) {
    const previous = next.objectiveResults;
    const statuses = next.simulation.commands.map((command) => command.status);
    const before = next.simulation.elapsedMinutes;
    const disturbances = (next.simulation.disturbances ?? []).map((fault) => ({
      applied: fault.applied,
      ended: fault.ended,
    }));
    const progress = next.simulation.commands.map((command) => command.progressMinutes);
    next.simulation = stepSimulation(next.simulation, next.minutesToImpact, 1 / 60);
    next.minutesToImpact = Math.max(0, Math.round((next.minutesToImpact - 1 / 60) * 60) / 60);
    next.objectiveResults = objectiveResults(next.simulation, next.scenario.objectives);
    for (const [index, fault] of (next.simulation.disturbances ?? []).entries()) {
      if (
        fault.applied !== disturbances[index]?.applied ||
        fault.ended !== disturbances[index]?.ended
      )
        next.timeline.push(
          missionEvent(next, {
            kind: "system",
            event:
              fault.kind === "repair_failure"
                ? "Repair actuator interruption detected."
                : fault.ended
                  ? "Communications capacity restored after a temporary outage."
                  : "Temporary communications outage detected.",
            objectives: next.objectiveResults,
          })
        );
    }
    if (
      next.simulation.commands.some((command, index) => command.progressMinutes > progress[index])
    )
      next.lastExecutionProgressAtMinutes = next.simulation.elapsedMinutes;
    evaluateOutcome(next, previous);
    const completed = next.simulation.commands.filter(
      (command, index) =>
        command.status !== statuses[index] &&
        (command.status === "succeeded" || command.status === "failed")
    );
    if (completed.length && next.phase === "executing")
      next.timeline.push(
        missionEvent(next, {
          event:
            "Command update: " +
            completed
              .map(
                (command) =>
                  actionLabels[command.action] + ": " + command.status + ". " + command.detail
              )
              .join(" "),
          kind: "system",
        })
      );
    const start = next.executionStartedAtMinutes ?? 0;
    const reportDue =
      Math.floor((next.simulation.elapsedMinutes - start + 1e-8) / monitoringIntervalMinutes) >
      Math.floor((before - start + 1e-8) / monitoringIntervalMinutes);
    if (reportDue || next.phase !== "executing") {
      next.monitoringIntervals++;
      next.timeline.push(
        missionEvent(next, {
          event:
            "Monitoring report " +
            next.monitoringIntervals +
            ": " +
            next.simulation.commands
              .map(
                (command) =>
                  actionLabels[command.action] + ": " + command.status + ". " + command.detail
              )
              .join(" "),
          kind: "system",
        })
      );
    }
  }
  next.telemetry = observeMissionTelemetry(
    next.simulation,
    next.scenario,
    next.minutesToImpact,
    state.telemetry
  );
  return next;
}
