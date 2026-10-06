import "../server/env.js";
import { execFileSync } from "node:child_process";
import { publicAgentProfiles } from "../server/agent-profiles.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  runMissionDirector,
  resolveMissionApproval,
  clearMissionSession,
  missionUsage,
} from "../server/agents.js";
import { approveCommand, requestCommand, advanceMission } from "../server/mission.js";
import { actionOracle } from "./promptfoo/oracle.js";
import { InvestigationError, investigationLimits } from "../server/investigation-budget.js";
import {
  benchmarkCases,
  benchmarkVariants,
  summarizeBenchmark,
  type BenchmarkRow,
} from "./benchmark-cases.js";

// Explicit command only: this calls the live API and authorizes fictional actions
// inside the evaluation harness. The application's human approval gate is unchanged.
if (!process.env.OPENAI_API_KEY)
  throw new Error("Configure OPENAI_API_KEY before running the live benchmark.");
const repeats = Number(process.env.BENCHMARK_REPEATS ?? 1);
const concurrency = Number(process.env.BENCHMARK_CONCURRENCY ?? 2);
const suiteCostLimit = Number(process.env.BENCHMARK_MAX_ESTIMATED_COST_USD ?? 3);
if (
  !Number.isInteger(repeats) ||
  repeats < 1 ||
  repeats > 10 ||
  !Number.isInteger(concurrency) ||
  concurrency < 1 ||
  concurrency > 4 ||
  !Number.isFinite(suiteCostLimit) ||
  suiteCostLimit <= 0
)
  throw new Error("Invalid benchmark limits.");
const selectedScenarios = process.env.BENCHMARK_SCENARIOS?.split(",").map((value) => value.trim());
const selectedVariants = process.env.BENCHMARK_VARIANTS?.split(",").map((value) => value.trim());
if (selectedVariants?.some((value) => !benchmarkVariants.some((variant) => variant === value)))
  throw new Error("Unknown benchmark variant.");
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const workingTreeDirty =
  execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
const allCases = benchmarkCases(repeats, selectedVariants, process.env.BENCHMARK_SEED ?? "release");
if (selectedScenarios?.some((value) => !allCases.some((item) => item.state.scenario.id === value)))
  throw new Error("Unknown benchmark scenario.");
const cases = allCases.filter(
  (item) =>
    (!selectedScenarios || selectedScenarios.includes(item.state.scenario.id)) &&
    (!selectedVariants || selectedVariants.includes(item.variant))
);
const perMissionReservation = investigationLimits().estimatedCostUsd;
const rows: BenchmarkRow[] = [];
let next = 0;
let stop = false;
const directory = resolve("evals/results");
mkdirSync(directory, { recursive: true });
const output = join(
  directory,
  "benchmark-" + new Date().toISOString().replaceAll(":", "-") + ".json"
);
function save() {
  writeFileSync(
    output,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        expectedCases: cases.length,
        complete: rows.length === cases.length,
        settings: {
          revision,
          workingTreeDirty,
          repeats,
          concurrency,
          suiteCostLimit,
          selectedScenarios,
          selectedVariants,
          agentProfiles: publicAgentProfiles,
          investigationLimits: investigationLimits(),
        },
        summary: summarizeBenchmark(rows),
        rows,
      },
      null,
      2
    ) + "\n"
  );
}
async function worker() {
  while (!stop && next < cases.length) {
    const { state, variant, repeat } = cases[next++];
    const started = Date.now();
    const row: BenchmarkRow = {
      expectedFeasibility: actionOracle(state).feasible ? "feasible" : "infeasible_single_proposal",
      scenario: state.scenario.id,
      variant,
      repeat,
      status: "error",
      elapsedMs: 0,
      consultations: 0,
      validationRetries: 0,
      unmet: [],
      initialConditions: structuredClone(state.simulation.conditions),
      seed: state.variation?.seed,
      replans: 0,
      plans: [],
    };
    try {
      let result = state;
      for (let attempt = 0; attempt <= 2; attempt++) {
        const assessment = await runMissionDirector(
          result,
          undefined,
          undefined,
          attempt ? result.replanning?.reason : undefined
        );
        row.approvalReadyMs ??= Date.now() - started;
        row.consultations += assessment.investigation.consultations;
        row.validationRetries += assessment.investigation.validationRetries;
        row.actions = assessment.plan.actions;
        row.plans!.push({
          actions: assessment.plan.actions,
          elapsedMinutes: result.simulation.elapsedMinutes,
        });
        const proposal = {
          ...requestCommand(result, assessment.plan),
          proposalId: assessment.proposalId,
        };
        const decision = await resolveMissionApproval(proposal, true, assessment.proposalId);
        row.estimatedCostUsd = decision.usage.estimatedCostUsd;
        row.accountingPending = decision.usage.accountingPending;
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
        row.replans = attempt + 1;
      }
      row.simulatedSeconds = Math.round(result.simulation.elapsedMinutes * 60);
      row.failureReason = result.failureReason;
      row.status =
        result.phase === "resolved"
          ? "resolved"
          : result.phase === "failed"
            ? "failed"
            : "unresolved";
      row.unmet = result.objectiveResults.filter((goal) => !goal.met).map((goal) => goal.label);
    } catch (error) {
      row.error = error instanceof Error ? error.message : "Assessment failed";
      if (error instanceof InvestigationError) {
        row.consultations += error.investigation.consultations;
        row.validationRetries += error.investigation.validationRetries;
        row.estimatedCostUsd = error.usage.estimatedCostUsd;
        row.accountingPending = error.usage.accountingPending;
      }
    } finally {
      row.elapsedMs = Date.now() - started;
      let finalUsage = await missionUsage(state.missionId);
      // Accounting is best effort. Give late snapshots a bounded chance to settle;
      // otherwise reserve the full mission allowance before dispatching more cases.
      for (let retry = 0; retry < 3 && finalUsage?.accountingPending; retry++) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        finalUsage = await missionUsage(state.missionId);
      }
      if (finalUsage) {
        row.estimatedCostUsd = finalUsage.estimatedCostUsd;
        row.knownEstimatedCostUsd = finalUsage.knownEstimatedCostUsd;
        row.accountingPending = finalUsage.accountingPending;
        row.inputTokens = finalUsage.inputTokens;
        row.outputTokens = finalUsage.outputTokens;
        row.totalTokens = finalUsage.totalTokens;
      }
      try {
        await clearMissionSession(state.missionId);
      } catch (error) {
        row.error = (row.error ?? "") + " Session cleanup failed: " + String(error);
        row.status = "error";
      }
      rows.push(row);
      save();
      console.log(JSON.stringify({ ...row, initialConditions: undefined }));
      const cost = rows.reduce(
        (total, item) =>
          total +
          (item.estimatedCostUsd ??
            Math.max(item.knownEstimatedCostUsd ?? 0, perMissionReservation)),
        0
      );
      if (cost >= suiteCostLimit) stop = true;
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, () => worker()));
save();
console.log(
  JSON.stringify({
    output,
    summary: summarizeBenchmark(rows),
    complete: rows.length === cases.length,
  })
);
// Treat unsuccessful and incomplete runs as release evidence, not a passing benchmark.
if (rows.length !== cases.length || rows.some((row) => row.status !== "resolved"))
  process.exitCode = 1;
