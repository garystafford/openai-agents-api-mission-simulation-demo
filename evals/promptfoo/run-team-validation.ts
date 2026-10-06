import "../../server/env.js";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { withAgentRecording, type RecordedConsultation } from "../../server/agent-recording.js";
import { specialistNames } from "../../server/mission-team.js";
import { advanceMission, approveCommand, requestCommand } from "../../server/mission.js";
import { connectMissionMcp } from "../../server/mission-evidence.js";
import { hardSafetyFailure } from "../../server/mission-rules.js";
import { actionOracle } from "./oracle.js";
import { directory } from "./dataset.js";
import { validationInputs, validationSeed } from "./validation-inputs.js";
import { sha256 } from "./saved-comparison.js";
import { investigationLimits } from "../../server/investigation-budget.js";

const finalSmoke = process.argv.includes("--final-smoke");
const preflightOnly = process.argv.includes("--preflight");
assert(
  preflightOnly || process.argv.includes("--live"),
  "Explicit --live required for paid team validation"
);
assert(process.env.OPENAI_API_KEY, "Existing API key is unavailable");
assert(
  investigationLimits().estimatedCostUsd <= 2,
  "Per-mission estimated limit exceeds suite reservation"
);
const policyPath = resolve(directory, "execution-policy.json");
const previousPolicy = JSON.parse(readFileSync(policyPath, "utf8"));
assert.equal(previousPolicy.status, "on_hold", "Another paid operation is released");
const selectionFile = finalSmoke ? "final-model-choices.json" : "selected-profiles.json";
const selectedBytes = readFileSync(resolve(directory, selectionFile));
const selection = JSON.parse(selectedBytes.toString());
const selected = finalSmoke
  ? {
      profiles: Object.fromEntries(
        selection.profiles.map(
          (profile: { role: string; model: string; reasoningEffort: string }) => [
            profile.role,
            { model: profile.model, reasoningEffort: profile.reasoningEffort },
          ]
        )
      ),
      sourceEvalId: "final-model-choices.json: staged development comparisons",
    }
  : selection;
const prefixes = {
  "Mission Director": "MISSION_DIRECTOR",
  "Power & Thermal": "POWER_THERMAL",
  "Life Support": "LIFE_SUPPORT",
  "Weather & Navigation": "WEATHER_NAVIGATION",
  "Risk Review": "RISK_REVIEW",
};
for (const [role, prefix] of Object.entries(prefixes)) {
  const profile = selected.profiles[role];
  assert(
    finalSmoke
      ? ["gpt-6-luna", "gpt-6-astra"].includes(profile.model)
      : profile.model === "gpt-6-luna"
  );
  assert(["low", "medium", "high"].includes(profile.reasoningEffort));
  process.env[prefix + "_MODEL"] = profile.model;
  process.env[prefix + "_REASONING_EFFORT"] = profile.reasoningEffort;
}
// Profiles are initialized on import: override only this process, before importing agents.
const {
  runMissionDirector,
  resolveMissionApproval,
  collectSpecialistAssessment,
  missionUsage,
  clearMissionSession,
} = await import("../../server/agents.js");
const { publicAgentProfiles } = await import("../../server/agent-profiles.js");
const { investigationFor } = await import("../../server/mission-investigations.js");
assert.deepEqual(publicAgentProfiles, selected.profiles);
const seed = finalSmoke ? "final-team-smoke-2026-10-05-v1" : validationSeed;
const inputs = validationInputs(seed, finalSmoke ? 1 : 2);
const expectedMissions = finalSmoke ? 5 : 10;
const estimatedReservationUsd = expectedMissions * 2;
assert.equal(inputs.length, expectedMissions);
const oracles = inputs.map(({ state }) => actionOracle(state));
const preflight = await connectMissionMcp(inputs[0].state);
await preflight.close();
if (preflightOnly) {
  console.log(
    JSON.stringify(
      {
        profiles: publicAgentProfiles,
        seed,
        expectedMissions,
        scenarios: inputs.map(({ state }, index) => ({
          scenario: state.scenario.id,
          feasible: oracles[index].feasible,
        })),
        coverageSupplements: !finalSmoke,
        estimatedReservationUsd,
        paidCalls: 0,
      },
      null,
      2
    )
  );
  process.exit(0);
}
const runId =
  (finalSmoke ? "final-team-smoke-" : "team-validation-") +
  new Date().toISOString().replaceAll(":", "-");
const outputDirectory = resolve(directory, "results", runId);
mkdirSync(outputDirectory, { recursive: false });
const saveJson = (file: string, value: unknown) =>
  writeFileSync(resolve(outputDirectory, file), JSON.stringify(value, null, 2) + "\n");
saveJson("inputs.json", inputs);
writeFileSync(
  resolve(outputDirectory, "run-team-validation.source.ts"),
  readFileSync(new URL(import.meta.url))
);
saveJson("source-snapshot.json", {
  capturedAtStart: true,
  filesSha256: Object.fromEntries(
    [
      "evals/promptfoo/run-team-validation.ts",
      "evals/promptfoo/validation-inputs.ts",
      "server/agents.ts",
      "server/agents-api.ts",
      "server/agent-profiles.ts",
      "server/agent-schemas.ts",
      "server/agent-recording.ts",
      "server/investigation-budget.ts",
      "server/mission.ts",
      "server/mission-rules.ts",
      "server/simulation.ts",
      "server/mission-evidence.ts",
      "server/mission-arithmetic.ts",
      "server/mission-usage.ts",
      "server/incident-variation.ts",
    ].map((file) => [file, sha256(readFileSync(resolve(file)))])
  ),
});
writeFileSync(resolve(outputDirectory, "selected-profiles.snapshot.json"), selectedBytes);
const { pricingPerMillion } = await import("../../server/mission-usage.js");
saveJson("pricing.snapshot.json", {
  capturedAtStart: true,
  source: "server/mission-usage.ts plus existing runtime overrides",
  rates: pricingPerMillion,
  caveat:
    "Nominal input/cache-read/output estimates; excludes separate cache-write accounting and is not an invoice",
});
const rows: Array<Record<string, unknown>> = [];
const records: RecordedConsultation[] = [];
const startedAt = new Date().toISOString();
const started = Date.now();
const manifest = {
  runId,
  startedAt,
  seed,
  expectedMissions,
  mode: finalSmoke ? "final-team-smoke" : "provisional-team-validation",
  coverageSupplements: !finalSmoke,
  selectionFile,
  sourceEvalId: selected.sourceEvalId,
  selectedProfilesSha256: sha256(selectedBytes),
  inputSha256: sha256(readFileSync(resolve(outputDirectory, "inputs.json"))),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  workingTreeDirty:
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
  profiles: publicAgentProfiles,
  estimatedReservationUsd,
  concurrency: 1,
  productionDefaultsChanged: false,
  complete: false,
  rows,
};
const save = () => saveJson("manifest.json", manifest);
const record = (value: RecordedConsultation) => {
  records.push(value);
  saveJson(value.id + ".json", value);
};
const questions = {
  "Power & Thermal":
    "Assess current electrical and thermal risks, feasible mitigations, and power/time trade-offs. Use current evidence and distinguish supported calculations from missing readings.",
  "Life Support":
    "Assess current cabin and air-processing risks, crew exposure concerns, justified mitigations and missing readings. Distinguish observed throughput from unmeasured cabin atmosphere.",
  "Weather & Navigation":
    "Assess fixed hazard timing, current crew location, return feasibility, prerequisites and evidence gaps. Explain whether recall applies.",
  "Risk Review":
    "Challenge incident-response assumptions. Identify material unsafe trade-offs, timing/resource constraints, missing evidence and limitations of simulated cross-checks.",
};
let reserved = 0;
let consecutiveErrors = 0;
let stopping = false;
let activeMissionId: string | undefined;
const stop = () => {
  stopping = true;
  if (activeMissionId)
    investigationFor(activeMissionId)?.api.budget?.stop(
      "Validation interrupted; stop new missions and clean up hosted sessions."
    );
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
save();
try {
  writeFileSync(
    policyPath,
    JSON.stringify(
      {
        ...previousPolicy,
        status: "released",
        allowedOperations: ["candidate"],
        reason: "User authorized a bounded selected-profile team validation",
        validationScope: {
          runId,
          maxMissions: expectedMissions,
          estimatedReservationUsd,
          inputsSha256: manifest.inputSha256,
        },
      },
      null,
      2
    ) + "\n"
  );
  for (const [index, { state, repeat, conditionsSha256 }] of inputs.entries()) {
    if (stopping) break;
    activeMissionId = state.missionId;
    assert(reserved + 2 <= estimatedReservationUsd, "Validation reservation exhausted");
    reserved += 2;
    const missionStarted = Date.now();
    const row: Record<string, unknown> = {
      missionId: state.missionId,
      scenario: state.scenario.id,
      repeat,
      conditionsSha256,
      feasible: oracles[index].feasible,
      status: "running",
      plans: [],
    };
    rows.push(row);
    save();
    console.log(
      JSON.stringify({ event: "validation_started", scenario: state.scenario.id, repeat })
    );
    try {
      let result = state;
      for (let attempt = 0; attempt <= 2; attempt++) {
        const assessment = await withAgentRecording(result, "director_selected", record, () =>
          runMissionDirector(
            result,
            undefined,
            undefined,
            attempt ? result.replanning?.reason : undefined
          )
        );
        row.approvalReadyMs ??= Date.now() - missionStarted;
        const proposal = {
          ...requestCommand(result, assessment.plan),
          proposalId: assessment.proposalId,
        };
        await resolveMissionApproval(proposal, true, assessment.proposalId);
        (row.plans as unknown[]).push({
          actions: assessment.plan.actions,
          elapsedMinutes: result.simulation.elapsedMinutes,
          exactProposalApproved: true,
        });
        result = approveCommand(proposal, true);
        for (let steps = 0; result.phase === "executing" && steps < 100; steps++)
          result = advanceMission(result);
        if (
          result.phase !== "assessment" ||
          result.replanning?.status !== "queued" ||
          attempt === 2
        )
          break;
        result.replanning.attempts = attempt + 1;
      }
      row.status = result.phase;
      row.outcome = {
        phase: result.phase,
        failureReason: result.failureReason,
        objectives: result.objectiveResults,
        elapsedMinutes: result.simulation.elapsedMinutes,
        hardFailure: hardSafetyFailure(result.simulation.conditions, result.objectiveResults),
      };
      saveJson(state.missionId + ".final-state.json", result);
      // Coverage supplements cannot affect the selected team's completed mission.
      const missing = finalSmoke
        ? []
        : specialistNames.filter(
            (role) =>
              !records.some(
                (r) => r.state.missionId === state.missionId && r.role === role && !r.error
              )
          );
      row.supplementedRoles = missing;
      for (const role of missing)
        await withAgentRecording(state, "coverage_supplement", record, () =>
          collectSpecialistAssessment(state, role, questions[role])
        );
      consecutiveErrors = 0;
    } catch (error) {
      row.status = "error";
      row.error = String(error);
      consecutiveErrors++;
    } finally {
      let usage = await missionUsage(state.missionId);
      for (let retry = 0; retry < 3 && usage?.accountingPending; retry++) {
        await new Promise((done) => setTimeout(done, 2000));
        usage = await missionUsage(state.missionId);
      }
      row.usage = usage;
      row.usageSnapshot = investigationFor(state.missionId)?.usage.snapshot();
      row.recordIds = records.filter((r) => r.state.missionId === state.missionId).map((r) => r.id);
      try {
        await clearMissionSession(state.missionId);
        row.sessionsDeleted = true;
      } catch (error) {
        row.sessionsDeleted = false;
        row.cleanupError = String(error);
      }
      row.elapsedMs = Date.now() - missionStarted;
      save();
      console.log(
        JSON.stringify({
          event: "validation_finished",
          scenario: state.scenario.id,
          repeat,
          status: row.status,
          records: (row.recordIds as string[]).length,
          elapsedMs: row.elapsedMs,
          accountingPending: usage?.accountingPending,
          estimatedCostUsd: usage?.estimatedCostUsd,
          sessionsDeleted: row.sessionsDeleted,
        })
      );
    }
    if (consecutiveErrors >= 2) break;
  }
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  writeFileSync(policyPath, JSON.stringify(previousPolicy, null, 2) + "\n");
  manifest.complete =
    rows.length === expectedMissions && rows.every((row) => row.status !== "error");
  save();
  saveJson("timing.json", {
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
  });
}
console.log(
  JSON.stringify({
    outputDirectory,
    complete: manifest.complete,
    records: records.length,
    reservedUsd: reserved,
  })
);
if (!manifest.complete) process.exitCode = 1;
