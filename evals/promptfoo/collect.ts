import "../../server/env.js";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { withAgentRecording, type RecordedConsultation } from "../../server/agent-recording.js";
import { publicAgentProfiles } from "../../server/agent-profiles.js";
import { specialistNames } from "../../server/mission-team.js";
import {
  runMissionDirector,
  collectSpecialistAssessment,
  resolveMissionApproval,
  clearMissionSession,
  missionUsage,
} from "../../server/agents.js";
import { investigationFor } from "../../server/mission-investigations.js";
import { approveCommand, advanceMission, requestCommand } from "../../server/mission.js";
import { benchmarkCases } from "../benchmark-cases.js";
import { connectMissionMcp } from "../../server/mission-evidence.js";
import { createMission } from "../../server/mission.js";

if (!process.argv.includes("--live"))
  throw new Error("Collection is paid. Explicitly pass --live. This does not run Promptfoo.");
if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required.");
const resumeIndex = process.argv.indexOf("--resume");
if (resumeIndex >= 0 && !process.argv[resumeIndex + 1])
  throw new Error("--resume requires a directory.");
const directory =
  resumeIndex >= 0
    ? resolve(process.argv[resumeIndex + 1])
    : resolve("evals/promptfoo/recordings", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(directory, { recursive: true });
type Row = Record<string, unknown>;
const previous =
  resumeIndex >= 0
    ? (JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as {
        rows: Row[];
        previousAttempts?: Row[];
      })
    : undefined;
const rows: Row[] = previous?.rows.filter((row) => row.status === "collected") ?? [];
const records: RecordedConsultation[] = rows.flatMap((row) =>
  (row.recordIds as string[]).map((id) =>
    JSON.parse(readFileSync(join(directory, id + ".json"), "utf8"))
  )
);
const manifest = {
  version: 1,
  directory,
  createdAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  workingTreeDirty:
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0,
  profiles: publicAgentProfiles,
  expectedMissions: 10,
  complete: false,
  rows,
  previousAttempts: [
    ...(previous?.previousAttempts ?? []),
    ...(previous?.rows.filter((row) => row.status !== "collected") ?? []),
  ],
};
function save() {
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}
function record(value: RecordedConsultation) {
  records.push(value);
  writeFileSync(join(directory, value.id + ".json"), JSON.stringify(value, null, 2) + "\n");
}
const questions = {
  "Power & Thermal":
    "Assess the current electrical and thermal risks, feasible mitigations, and their power/time trade-offs. Use current evidence and distinguish known constraints from missing readings.",
  "Life Support":
    "Assess current cabin and air-processing risks. Identify any material life-support concern, justified mitigation, and missing readings; distinguish nominal observed systems from unmeasured ones.",
  "Weather & Navigation":
    "Assess current hazard timing, field-crew location and return feasibility. Identify navigation prerequisites and evidence gaps using current mission observations.",
  "Risk Review":
    "Challenge the incident response assumptions using current evidence. Identify material unsafe trade-offs, missing evidence, timing or resource constraints, and limits of simulated cross-checks.",
};
// Check local evidence tools before any paid model call.
const preflight = await connectMissionMcp(createMission());
await preflight.close();
save();
let spent = rows.reduce(
  (total, row) => total + ((row.usage as { estimatedCostUsd?: number })?.estimatedCostUsd ?? 2),
  0
);
let consecutiveErrors = 0;
for (const { state, variant } of benchmarkCases(
  1,
  ["baseline", "reduced_reserve"],
  "promptfoo-v1"
)) {
  if (
    rows.some(
      (row) =>
        row.scenario === state.scenario.id && row.variant === variant && row.status === "collected"
    )
  )
    continue;
  // Sequential collection makes per-mission accounting and cleanup inspectable.
  if (spent + 2 > 20) throw new Error("Collection suite cost reservation exhausted.");
  const started = Date.now();
  const row: Record<string, unknown> = {
    missionId: state.missionId,
    scenario: state.scenario.id,
    variant,
    seed: state.variation?.seed,
    status: "collecting",
  };
  rows.push(row);
  save();
  console.log(JSON.stringify({ event: "mission_started", scenario: state.scenario.id, variant }));
  try {
    const assessment = await withAgentRecording(state, "director_selected", record, () =>
      runMissionDirector(state)
    );
    const missing = specialistNames.filter(
      (role) =>
        !records.some(
          (r) =>
            r.state.missionId === state.missionId && r.role === role && !r.continuing && !r.error
        )
    );
    for (const role of missing) {
      await withAgentRecording(state, "coverage_supplement", record, () =>
        collectSpecialistAssessment(state, role, questions[role])
      );
    }
    const proposal = {
      ...requestCommand(state, assessment.plan),
      proposalId: assessment.proposalId,
    };
    await resolveMissionApproval(proposal, true, assessment.proposalId);
    let result = approveCommand(proposal, true);
    for (let step = 0; result.phase === "executing" && step < 100; step++)
      result = advanceMission(result);
    row.status = "collected";
    row.plan = assessment.plan;
    row.outcome = {
      phase: result.phase,
      outcome: result.outcome,
      objectives: result.objectiveResults,
      failureReason: result.failureReason,
      replanning: result.replanning,
    };
    row.supplementedRoles = missing;
    consecutiveErrors = 0;
  } catch (error) {
    row.status = "error";
    row.error = error instanceof Error ? error.message : String(error);
    consecutiveErrors++;
  } finally {
    row.usage = await missionUsage(state.missionId);
    row.usageSnapshot = investigationFor(state.missionId)?.usage.snapshot();
    const usage = row.usage as Awaited<ReturnType<typeof missionUsage>>;
    spent += usage?.estimatedCostUsd ?? 2;
    row.elapsedMs = Date.now() - started;
    row.recordIds = records.filter((r) => r.state.missionId === state.missionId).map((r) => r.id);
    try {
      await clearMissionSession(state.missionId);
      row.sessionsDeleted = true;
    } catch (error) {
      row.cleanupError = String(error);
      row.sessionsDeleted = false;
    }
    save();
    console.log(
      JSON.stringify({
        event: "mission_finished",
        scenario: state.scenario.id,
        variant,
        status: row.status,
        records: (row.recordIds as string[]).length,
        estimatedCostUsd: usage?.estimatedCostUsd,
        sessionsDeleted: row.sessionsDeleted,
      })
    );
  }
  if (consecutiveErrors >= 2) break;
}
manifest.complete =
  rows.length === 10 && rows.every((row) => (row as { status: string }).status === "collected");
save();
console.log(
  JSON.stringify({
    directory,
    complete: manifest.complete,
    records: records.length,
    reservedOrEstimatedCostUsd: spent,
  })
);
if (!manifest.complete) process.exitCode = 1;
