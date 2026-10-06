import "../../server/env.js";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createMission } from "../../server/mission.js";
import { ConsultationTimeoutError } from "../../server/agents-api.js";
import { publicAgentProfiles } from "../../server/agent-profiles.js";
import { createInvestigation } from "../../server/mission-investigations.js";
import {
  runMissionDirector,
  clearMissionSession,
  pendingMissionApproval,
} from "../../server/agents.js";
import { withAgentRecording } from "../../server/agent-recording.js";
import { connectMissionMcp } from "../../server/mission-evidence.js";
import {
  cancellationConfirmationMilliseconds,
  investigationLimits,
} from "../../server/investigation-budget.js";
import { pricingPerMillion } from "../../server/mission-usage.js";
import { finalizeRecordedAssessment } from "./finalize-assessment.js";

const root = resolve("evals/promptfoo");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const frozen = [
  "server/agent-profiles.ts",
  "evals/promptfoo/final-model-choices.json",
  "evals/promptfoo/execution-policy.json",
];
const cancellationMilliseconds = cancellationConfirmationMilliseconds();
const before = Object.fromEntries(frozen.map((file) => [file, hash(readFileSync(file))]));
const policy = JSON.parse(readFileSync(resolve(root, "execution-policy.json"), "utf8"));
assert.equal(policy.status, "on_hold");
assert.deepEqual(policy.allowedOperations, []);
const selected = JSON.parse(readFileSync(resolve(root, "final-model-choices.json"), "utf8"));
assert.deepEqual(
  publicAgentProfiles,
  Object.fromEntries(
    selected.profiles.map((p: { role: string; model: string; reasoningEffort: string }) => [
      p.role,
      { model: p.model, reasoningEffort: p.reasoningEffort },
    ])
  )
);
assert(investigationLimits().estimatedCostUsd <= 2);
assert(
  process.argv.includes("--preflight") || process.argv.includes("--live"),
  "Use --preflight or explicit --live"
);
const probe = await connectMissionMcp(createMission("dust_storm"));
await probe.close();
if (process.argv.includes("--preflight")) {
  console.log(
    JSON.stringify({
      paidCalls: 0,
      cancellationMilliseconds,
      accountingMilliseconds: 30000,
      cases: ["control", "cancel-power-at-first-tool"],
      maxAssessments: 2,
      maxNewSessionsPerAssessment: 3,
      estimatedReservationUsd: 4,
      profiles: publicAgentProfiles,
      comparisonHold: policy.status,
    })
  );
  process.exit(0);
}
assert(process.env.OPENAI_API_KEY, "Existing API key is unavailable");
const runId = "hardening-live-" + new Date().toISOString().replaceAll(":", "-");
const out = resolve(root, "results", runId);
mkdirSync(out, { recursive: true });
const save = (name: string, value: unknown) =>
  writeFileSync(resolve(out, name), JSON.stringify(value, null, 2) + "\n");
const rows: Array<Record<string, unknown>> = [];
const manifest = {
  runId,
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  startedAt: new Date().toISOString(),
  completed: false,
  scope:
    "Two assessment-only cases; fault injection at a live Power tool boundary. No command execution, model comparison, or judge.",
  profiles: publicAgentProfiles,
  estimatedReservationUsd: 4,
  pricingPerMillion,
  cancellationMilliseconds,
  accountingMilliseconds: 30000,
  frozenHashes: before,
  rows,
};
save("authorization.json", {
  source: "User explicitly authorized small live validation in this chat",
  maxAssessments: 2,
  maxNewSessionsPerAssessment: 3,
  comparisonRemainsOnHold: true,
  automaticRetries: false,
});
save("manifest.json", manifest);
writeFileSync(resolve(out, "harness.source.ts"), readFileSync(new URL(import.meta.url)));
save(
  "source-hashes.json",
  Object.fromEntries(
    [
      ...frozen,
      "server/agents.ts",
      "server/agents-api.ts",
      "server/mission-arithmetic.ts",
      "server/agent-recording.ts",
      "server/investigation-budget.ts",
      "server/mission-usage.ts",
      "evals/promptfoo/accounting.ts",
      "evals/promptfoo/finalize-assessment.ts",
    ].map((file) => [file, hash(readFileSync(file))])
  )
);
let active: ReturnType<typeof createInvestigation> | undefined;
let interrupted = false;
const stop = () => {
  interrupted = true;
  active?.api.budget?.stop("Live hardening validation interrupted");
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const runStarted = Date.now();
try {
  for (const mode of ["control", "cancel-power-at-first-tool"] as const) {
    if (interrupted) break;
    const state = createMission("dust_storm");
    const stateBefore = hash(JSON.stringify(state));
    const current = createInvestigation(state.missionId);
    active = current;
    const started = Date.now();
    const reports: unknown[] = [],
      log: unknown[] = [],
      lifecycle: unknown[] = [];
    const starts: string[] = [],
      followups: string[] = [];
    let injected = false,
      faultStopConfirmed = false;
    let assessmentError: string | undefined;
    const row: Record<string, unknown> = {
      mode,
      missionId: state.missionId,
      startedAt: new Date().toISOString(),
      status: "running",
      starts,
      followups,
      reports,
      log,
      lifecycle,
    };
    rows.push(row);
    save("manifest.json", manifest);
    save(mode + ".input.json", state);
    console.log(JSON.stringify({ event: "assessment_started", mode, missionId: state.missionId }));
    const sessions = current.api.client.beta.agents.sessions;
    const retrieve = sessions.retrieve.bind(sessions);
    sessions.retrieve = ((...args: Parameters<typeof sessions.retrieve>) =>
      retrieve(...args).then((value) => {
        lifecycle.push({
          at: new Date().toISOString(),
          event: "session_status",
          sessionId: args[0],
          status: value.status,
        });
        return value;
      })) as typeof sessions.retrieve;
    const retrieveTurn = sessions.turns.retrieve.bind(sessions.turns);
    sessions.turns.retrieve = ((...args: Parameters<typeof sessions.turns.retrieve>) =>
      retrieveTurn(...args).then((value) => {
        lifecycle.push({
          at: new Date().toISOString(),
          event: "turn_status",
          sessionId: args[1].session_id,
          turnId: args[0],
          status: value.status,
        });
        return value;
      })) as typeof sessions.turns.retrieve;
    const cancel = current.api.cancel.bind(current.api);
    current.api.cancel = async (...args) => {
      lifecycle.push({
        at: new Date().toISOString(),
        event: "cancel_begin",
        role: args[0].role,
        sessionId: args[0].id,
      });
      await cancel(...args);
      lifecycle.push({
        at: new Date().toISOString(),
        event: "stop_confirmed",
        role: args[0].role,
        sessionId: args[0].id,
      });
    };
    const start = current.api.start.bind(current.api);
    current.api.start = async (ref, agent, input, handler) => {
      assert(["Mission Director", "Power & Thermal", "Weather & Navigation"].includes(ref.role!));
      assert(starts.length < 3, "Live validation session bound reached");
      starts.push(ref.role!);
      return start(ref, agent, input, async (call) => {
        if (mode === "cancel-power-at-first-tool" && ref.role === "Power & Thermal" && !injected) {
          injected = true;
          lifecycle.push({
            at: new Date().toISOString(),
            event: "fault_injected",
            role: ref.role,
            sessionId: ref.id,
            turnId: ref.turnId,
            call,
          });
          console.log(JSON.stringify({ event: "fault_injected", mode, role: ref.role }));
          await current.api.cancel(ref);
          faultStopConfirmed = true;
          throw new ConsultationTimeoutError(ref.role);
        }
        return handler(call);
      });
    };
    const send = current.api.send.bind(current.api);
    current.api.send = async (ref, input, handler) => {
      assert(
        ref.role === "Mission Director" && followups.length < 1,
        "Live validation follow-up bound reached"
      );
      followups.push(ref.role);
      return send(ref, input, handler);
    };
    try {
      const result = await withAgentRecording(
        state,
        "director_selected",
        (record) => save(record.id + ".json", record),
        () =>
          runMissionDirector(
            state,
            (entry) => log.push(entry),
            (report) => reports.push(report),
            "For this focused assessment, consult Power & Thermal and Weather & Navigation concurrently using consult_specialists. Request no other roles and no follow-up consultations. Give both a focused incident question. Apply the normal missing-specialist policy. If both reports succeed, submit an evidence-based plan for commander review. Do not execute actions."
          )
      );
      row.result = result;
    } catch (error) {
      assessmentError = error instanceof Error ? error.message : String(error);
      row.error = assessmentError;
    } finally {
      row.assessmentElapsedMs = Date.now() - started;
      row.injected = injected;
      row.faultStopConfirmed = faultStopConfirmed;
      row.hasPendingApproval = Boolean(pendingMissionApproval(state.missionId));
      row.stateUnchanged = hash(JSON.stringify(state)) === stateBefore;
      row.passed =
        mode === "control"
          ? !assessmentError && reports.length === 2 && row.hasPendingApproval && row.stateUnchanged
          : injected &&
            faultStopConfirmed &&
            /Assessment incomplete.*Power & Thermal/.test(assessmentError ?? "") &&
            reports.length === 1 &&
            !row.hasPendingApproval &&
            row.stateUnchanged &&
            starts.filter((role) => role === "Power & Thermal").length === 1 &&
            followups.length === 0;
      current.api.budget = undefined;
      const finalization = await finalizeRecordedAssessment({
        api: current.api,
        usage: current.usage,
        refs: current.sessions.all(),
        persist: (evidence) => save(mode + ".finalization.json", evidence),
        cleanup: () => clearMissionSession(state.missionId),
      });
      row.usage = finalization.accounting.summary;
      row.accounting = {
        attempts: finalization.accounting.attempts,
        error: finalization.accounting.error,
      };
      row.stopConfirmations = finalization.stops;
      row.evidenceError = finalization.evidenceError;
      row.cleanup = finalization.cleanupError ? "unconfirmed" : "all sessions deleted";
      row.cleanupError = finalization.cleanupError;
      row.finalizationPassed =
        finalization.stops.every((stop) => stop.confirmed) &&
        !finalization.evidenceError &&
        !finalization.cleanupError &&
        !finalization.accounting.summary.accountingPending &&
        finalization.accounting.summary.unpricedModels.length === 0;
      row.elapsedMs = Date.now() - started;
      row.status = row.passed && row.finalizationPassed ? "passed" : "failed";
      save("manifest.json", manifest);
      console.log(
        JSON.stringify({
          event: "assessment_finished",
          mode,
          passed: row.passed,
          finalizationPassed: row.finalizationPassed,
          error: row.error,
          elapsedMs: row.elapsedMs,
          usage: row.usage,
          cleanup: row.cleanup,
        })
      );
    }
    active = undefined;
    if (!row.finalizationPassed || interrupted) break;
  }
} finally {
  manifest.completed = rows.length === 2 && rows.every((row) => row.status !== "running");
  save("manifest.json", {
    ...manifest,
    elapsedMs: Date.now() - runStarted,
    finishedAt: new Date().toISOString(),
  });
  for (const file of frozen)
    assert.equal(
      hash(readFileSync(file)),
      before[file],
      "Protected configuration changed: " + file
    );
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  console.log(
    JSON.stringify({
      event: "validation_finished",
      runId,
      completed: manifest.completed,
      elapsedMs: Date.now() - runStarted,
      comparisonRemainsOnHold: true,
    })
  );
  if (!manifest.completed || rows.some((row) => !row.passed || !row.finalizationPassed))
    process.exitCode = 1;
}
