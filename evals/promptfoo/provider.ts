import "../../server/env.js";
import OpenAI from "openai";
import {
  AgentsApi,
  toolError,
  toolResult,
  type FunctionCall,
  type SessionRef,
} from "../../server/agents-api.js";
import { MissionUsageCollector } from "../../server/mission-usage.js";
import { replayContext } from "./replay.js";
import {
  InvestigationBudget,
  specialistDeadlineMilliseconds,
} from "../../server/investigation-budget.js";
import { connectMissionMcp } from "../../server/mission-evidence.js";
import {
  arithmeticValidationFeedback,
  evidenceFailureFeedback,
} from "../../server/mission-arithmetic.js";
import {
  parseArguments,
  parseBatchConsultations,
  validateMissionPlan,
  planValidationFeedback,
} from "../../server/agent-schemas.js";
import { loadCase, type ReviewedCase } from "./dataset.js";
import { assertComparisonReleased } from "./execution-policy.js";
import { settleAccounting } from "./accounting.js";

export type ReplayResult = {
  answer: unknown;
  tools: Array<{
    name: string;
    arguments: unknown;
    success: boolean;
    output?: unknown;
    error?: string | null;
  }>;
};
export const consultationRoles: Record<string, string> = {
  consult_power: "Power & Thermal",
  consult_life_support: "Life Support",
  consult_weather: "Weather & Navigation",
  consult_red_team: "Risk Review",
};

// The Director gets the same fixed specialist reports regardless of candidate
// model. It may choose a different route/question; replies are state fixtures,
// not claims to rerun the specialist or answer new hypothetical questions.
export function directorToolHandler(item: ReviewedCase) {
  let consultations = 0;
  return async (call: FunctionCall) => {
    const args = parseArguments(call);
    if (call.name === "submit_mission_plan") {
      if (!consultations)
        return toolError(
          call,
          "Consult at least one specialist for fresh evidence before submitting a plan."
        );
      try {
        validateMissionPlan(replayContext(item).state, args);
        return null;
      } catch (error) {
        return toolError(call, planValidationFeedback(error));
      }
    }
    if (call.name === "consult_specialists") {
      const parsed = parseBatchConsultations(args);
      if (!parsed.success)
        return toolError(call, "Provide two to four distinct specialists, each with a question.");
      if (parsed.data.consultations.some(({ specialist }) => !item.fixedReports[specialist]))
        return toolError(call, "No recorded report exists for this specialist.");
      if (consultations + parsed.data.consultations.length > 12)
        return toolError(call, "Specialist consultation limit reached.");
      consultations += parsed.data.consultations.length;
      return toolResult(
        call,
        parsed.data.consultations.map(({ specialist }) => ({
          agent: specialist,
          ...(item.fixedReports[specialist] as object),
        }))
      );
    }
    const role = consultationRoles[call.name];
    if (!role || !item.fixedReports[role])
      return toolError(call, "Unknown specialist or missing recorded report.");
    if (
      !args ||
      typeof args !== "object" ||
      !("question" in args) ||
      typeof args.question !== "string" ||
      !args.question.trim()
    )
      return toolError(call, "Provide a non-empty question for the specialist.");
    if (++consultations > 12) return toolError(call, "Specialist consultation limit reached.");
    return toolResult(call, item.fixedReports[role]);
  };
}

export default class MissionAgentProvider {
  protected config: { model: string; effort: "low" | "medium" | "high" };
  protected focused = false;
  private label: string;
  constructor(
    options: { id?: string; config?: { model?: string; effort?: "low" | "medium" | "high" } } = {}
  ) {
    this.config = {
      model: options.config?.model ?? "gpt-6-luna",
      effort: options.config?.effort ?? "low",
    };
    this.label = this.config.model + ":" + this.config.effort;
  }
  id() {
    return this.label;
  }
  protected loadReplayCase(id: string) {
    return loadCase(id);
  }
  protected validateConfiguration() {
    if (
      this.config.model !== "gpt-6-luna" ||
      !["low", "medium", "high"].includes(this.config.effort)
    )
      throw new Error("Unsupported initial evaluation configuration.");
  }
  async callApi(prompt: string) {
    const started = Date.now();
    const phases = { setupMs: 0, inferenceMs: 0, accountingMs: 0, cleanupMs: 0, totalMs: 0 };
    const authorization = assertComparisonReleased();
    if (authorization.focusedScope && !this.focused)
      throw new Error("Use the bounded focused provider for this candidate authorization.");
    if (process.env.MARS_PROMPTFOO_LIVE !== "1")
      throw new Error(
        "Paid Promptfoo comparison is disabled. Use npm run eval:models -- --live only when authorized."
      );
    this.validateConfiguration();
    const item = this.loadReplayCase(prompt.trim());
    if (item.record.continuing)
      throw new Error("This initial replay suite only supports fresh-session consultations.");
    const replay = replayContext(item);
    const usage = new MissionUsageCollector();
    const api = new AgentsApi(new OpenAI({ maxRetries: 0, timeout: 180000 }), usage);
    const budget = new InvestigationBudget(undefined, () => usage.summary());
    api.budget = budget;
    const ref: SessionRef = {
      model: this.config.model,
      role: item.record.role,
      results: new Map(),
    };
    const director = item.record.role === "Mission Director";
    const mcp = director ? undefined : await connectMissionMcp(replay.state);
    const availableTools = mcp
      ? new Set((await mcp.listTools()).tools.map((tool) => tool.name))
      : new Set<string>();
    const handleDirector = directorToolHandler(item);
    let evidenceCalls = 0;
    const sources = new Set<string>();
    const tools: ReplayResult["tools"] = [];
    phases.setupMs = Date.now() - started;
    try {
      const inferenceStarted = Date.now();
      const operation = () =>
        api.start(
          ref,
          {
            ...replay.agent,
            model: this.config.model,
            reasoning: { effort: this.config.effort },
          },
          replay.input,
          async (call) => {
            let reply;
            if (director) reply = await handleDirector(call);
            else if (!availableTools.has(call.name))
              reply = toolError(call, "Unknown mission evidence tool.");
            else if (++evidenceCalls > 4)
              reply = toolError(
                call,
                "Evidence lookup limit reached. Return a report with remaining uncertainty."
              );
            else {
              const source = call.name + ":" + JSON.stringify(parseArguments(call));
              if (sources.has(source))
                reply = toolError(
                  call,
                  "This source was already read in this consultation. Use the existing evidence."
                );
              else {
                sources.add(source);
                const validation = arithmeticValidationFeedback(
                  call.name,
                  parseArguments(call),
                  evidenceCalls
                );
                const evidence = validation
                  ? undefined
                  : await mcp!.callTool({
                      name: call.name,
                      arguments: parseArguments(call) as Record<string, unknown>,
                    });
                reply = validation
                  ? toolError(call, validation)
                  : evidence!.isError
                    ? toolError(call, evidenceFailureFeedback(evidenceCalls))
                    : toolResult(call, evidence);
              }
            }
            tools.push({
              name: call.name,
              arguments: parseArguments(call),
              success: reply === null || reply.success,
              ...(reply && reply.success ? { output: reply.output } : {}),
              ...(reply && !reply.success ? { error: reply.error } : {}),
            });
            return reply;
          }
        );
      const result = director
        ? await operation()
        : await api.withConsultationDeadline(ref, specialistDeadlineMilliseconds(), operation);
      const answer = result.pending ? parseArguments(result.pending) : JSON.parse(result.text);
      phases.inferenceMs = Date.now() - inferenceStarted;
      budget.finish();
      api.budget = undefined;
      // A Director draft without a submit tool call is deliberately a failed
      // episode, even if the draft looks valid. The grader checks this below.
      const accountingStarted = Date.now();
      const accountingBudget = new InvestigationBudget({ ...budget.limits, milliseconds: 10000 });
      let accounting: Awaited<ReturnType<typeof settleAccounting>>;
      try {
        api.budget = accountingBudget;
        accounting = await settleAccounting(
          () => api.refreshUsage([ref]),
          () => usage.summary(),
          { signal: accountingBudget.controller.signal }
        );
      } finally {
        accountingBudget.finish();
        api.budget = undefined;
      }
      const summary = accounting.summary;
      phases.accountingMs = Date.now() - accountingStarted;
      return {
        output: JSON.stringify({ answer, tools } satisfies ReplayResult),
        cached: false,
        tokenUsage: {
          prompt: summary.inputTokens,
          completion: summary.outputTokens,
          total: summary.totalTokens,
          cached: summary.cachedInputTokens,
        },
        ...(summary.estimatedCostUsd === undefined ? {} : { cost: summary.estimatedCostUsd }),
        metadata: {
          caseId: item.id,
          sessionId: ref.id,
          turnId: ref.turnId,
          reasoningTokens: summary.reasoningTokens,
          accountingPending: summary.accountingPending,
          role: item.record.role,
          phases,
          accountingAttempts: accounting.attempts,
          accountingError: accounting.error,
          usageSnapshot: usage.snapshot(),
          pricingCaveat:
            "Runtime estimate does not retain cache-write counts; not a billing reconciliation",
        },
      };
    } finally {
      const cleanupStarted = Date.now();
      budget.finish();
      api.budget = undefined;
      await mcp?.close();
      await api.dispose(ref);
      phases.cleanupMs = Date.now() - cleanupStarted;
      phases.totalMs = Date.now() - started;
    }
  }
}
