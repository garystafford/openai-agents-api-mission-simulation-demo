import type { TokenUsage } from "openai/resources/beta/agents/agents";
import type { MissionUsage, ModelUsage } from "./mission-contract.js";

type TokenPricing = {
  input: number;
  cachedInput: number;
  output: number;
};

const standardPricingPerMillion: Record<string, TokenPricing> = {
  "gpt-6-sol": { input: 2, cachedInput: 0.2, output: 10 },
  "gpt-6-astra": { input: 10, cachedInput: 1, output: 50 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
};

function configuredPricing() {
  const value = process.env.MISSION_COST_PRICING_OVERRIDES?.trim();
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, Partial<TokenPricing>>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([model, rate]) => {
        if (
          !Number.isFinite(rate.input) ||
          !Number.isFinite(rate.cachedInput) ||
          !Number.isFinite(rate.output)
        )
          return [];
        return [[model, rate as TokenPricing]];
      })
    ) as Record<string, TokenPricing>;
  } catch {
    return {};
  }
}

export const pricingPerMillion = { ...standardPricingPerMillion, ...configuredPricing() };

type UsageSample = {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
};

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function usageSample(usage: TokenUsage, model: string): UsageSample {
  return {
    model,
    inputTokens: numberValue(usage.input_tokens),
    cachedInputTokens: numberValue(usage.input_tokens_details?.cached_tokens),
    outputTokens: numberValue(usage.output_tokens),
    reasoningTokens: numberValue(usage.output_tokens_details?.reasoning_tokens),
    totalTokens: numberValue(usage.total_tokens),
  };
}

function estimateCost(
  usage: Pick<ModelUsage, "inputTokens" | "cachedInputTokens" | "outputTokens">,
  pricing: TokenPricing
) {
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return (
    (uncachedInput * pricing.input +
      usage.cachedInputTokens * pricing.cachedInput +
      usage.outputTokens * pricing.output) /
    1_000_000
  );
}

export class MissionUsageCollector {
  snapshot() {
    return { samples: [...this.samples], missing: [...this.missingUsage] };
  }
  restore(value: ReturnType<MissionUsageCollector["snapshot"]>) {
    for (const [id, sample] of value.samples) this.samples.set(id, sample);
    for (const id of value.missing) this.missingUsage.add(id);
  }
  private readonly samples = new Map<string, UsageSample>();
  private readonly missingUsage = new Set<string>();

  // Preserve known charges, but require a fresh provider snapshot after termination.
  requireReconciliation(turnId: string, model: string) {
    this.record(turnId, null, model);
    this.missingUsage.add(turnId);
  }

  record(turnId: string, usage: TokenUsage | null, model: string) {
    if (!usage) {
      if (!this.samples.has(turnId)) {
        this.missingUsage.add(turnId);
        this.samples.set(turnId, {
          model,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
        });
      }
      return;
    }
    this.missingUsage.delete(turnId);
    // API accounting can arrive late. Replace snapshots instead of accumulating
    // cumulative turn/session counts or charging the same turn twice.
    this.samples.set(turnId, usageSample(usage, model));
  }

  summary(): MissionUsage {
    const byModel = new Map<string, ModelUsage>();
    for (const sample of this.samples.values()) {
      const current = byModel.get(sample.model) ?? {
        model: sample.model,
        requests: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        visibleOutputTokens: 0,
        totalTokens: 0,
      };
      current.requests += 1;
      current.inputTokens += sample.inputTokens;
      current.cachedInputTokens += sample.cachedInputTokens;
      current.outputTokens += sample.outputTokens;
      current.reasoningTokens += sample.reasoningTokens;
      current.visibleOutputTokens += Math.max(0, sample.outputTokens - sample.reasoningTokens);
      current.totalTokens += sample.totalTokens;
      byModel.set(sample.model, current);
    }
    const models = [...byModel.values()].sort(
      (left, right) => right.totalTokens - left.totalTokens
    );
    const unpricedModels: string[] = [];
    for (const model of models) {
      const pricing = pricingPerMillion[model.model];
      if (pricing) model.estimatedCostUsd = estimateCost(model, pricing);
      else unpricedModels.push(model.model);
    }
    const sum = (selector: (model: ModelUsage) => number) =>
      models.reduce((total, model) => total + selector(model), 0);
    const estimatedCostUsd =
      unpricedModels.length || this.missingUsage.size
        ? undefined
        : sum((model) => model.estimatedCostUsd ?? 0);
    return {
      requests: sum((model) => model.requests),
      inputTokens: sum((model) => model.inputTokens),
      cachedInputTokens: sum((model) => model.cachedInputTokens),
      outputTokens: sum((model) => model.outputTokens),
      reasoningTokens: sum((model) => model.reasoningTokens),
      visibleOutputTokens: sum((model) => model.visibleOutputTokens),
      totalTokens: sum((model) => model.totalTokens),
      ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
      knownEstimatedCostUsd: sum((model) => model.estimatedCostUsd ?? 0),
      accountingPending: this.missingUsage.size > 0,
      unpricedModels,
      byModel: models,
    };
  }
}
