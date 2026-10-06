import type { MissionUsage } from "./mission-contract.js";
export type InvestigationLimits = {
  milliseconds: number;
  consultations: number;
  functionCalls: number;
  tokens: number;
  estimatedCostUsd: number;
  validationRetries: number;
};
export type InvestigationMetrics = {
  consultations: number;
  functionCalls: number;
  validationRetries: number;
  elapsedMs: number;
  stopReason?: string;
};
function positive(env: NodeJS.ProcessEnv, key: string, value: number) {
  const parsed = Number(env[key] ?? value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(key + " must be a positive number.");
  return parsed;
}
// Independent cleanup window: remote status propagation can consume several seconds.
export function cancellationConfirmationMilliseconds(env: NodeJS.ProcessEnv = process.env) {
  const seconds = positive(env, "MISSION_CANCELLATION_SECONDS", 15);
  if (seconds > 60) throw new Error("MISSION_CANCELLATION_SECONDS must not exceed 60.");
  return seconds * 1000;
}
export function specialistDeadlineMilliseconds(env: NodeJS.ProcessEnv = process.env) {
  const shared = positive(env, "MISSION_INVESTIGATION_SECONDS", 240);
  return Math.min(positive(env, "MISSION_SPECIALIST_SECONDS", 120), shared * 0.75) * 1000;
}
export function investigationLimits(env: NodeJS.ProcessEnv = process.env): InvestigationLimits {
  return {
    milliseconds: positive(env, "MISSION_INVESTIGATION_SECONDS", 240) * 1000,
    consultations: positive(env, "MISSION_MAX_CONSULTATIONS", 12),
    functionCalls: positive(env, "MISSION_MAX_FUNCTION_CALLS", 64),
    tokens: positive(env, "MISSION_MAX_TOKENS", 500000),
    estimatedCostUsd: positive(env, "MISSION_MAX_ESTIMATED_COST_USD", 2),
    validationRetries: positive(env, "MISSION_MAX_VALIDATION_RETRIES", 3),
  };
}
export class InvestigationBudget {
  readonly controller = new AbortController();
  readonly startedAt = Date.now();
  readonly metrics: InvestigationMetrics = {
    consultations: 0,
    functionCalls: 0,
    validationRetries: 0,
    elapsedMs: 0,
  };
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(
    readonly limits = investigationLimits(),
    private readonly usage?: () => MissionUsage
  ) {
    this.timer = setTimeout(
      () => this.stop("Investigation time limit reached."),
      limits.milliseconds
    );
    this.timer.unref();
  }
  stop(message: string): never | void {
    if (!this.controller.signal.aborted) {
      this.metrics.stopReason = message;
      this.controller.abort(new Error(message));
    }
  }
  check() {
    if (Date.now() - this.startedAt >= this.limits.milliseconds)
      this.stop("Investigation time limit reached.");
    const usage = this.usage?.();
    if (usage?.unpricedModels.length)
      this.stop("Model pricing is unavailable; configure pricing before continuing.");
    if (usage && usage.totalTokens >= this.limits.tokens) this.stop("Mission token limit reached.");
    if (
      (usage?.estimatedCostUsd ?? usage?.knownEstimatedCostUsd ?? 0) >= this.limits.estimatedCostUsd
    )
      this.stop("Mission estimated cost limit reached.");
    this.controller.signal.throwIfAborted();
  }
  consult(count = 1) {
    this.check();
    if (this.metrics.consultations + count > this.limits.consultations) {
      this.stop("Specialist consultation limit reached.");
      this.check();
    }
    this.metrics.consultations += count;
  }
  functionCall() {
    this.check();
    if (++this.metrics.functionCalls > this.limits.functionCalls) {
      this.stop("Investigation function-call limit reached.");
      this.check();
    }
  }
  invalidProposal() {
    this.check();
    if (++this.metrics.validationRetries > this.limits.validationRetries) {
      this.stop("Proposal correction limit reached.");
      this.check();
    }
  }
  finish() {
    clearTimeout(this.timer);
    this.metrics.elapsedMs = Date.now() - this.startedAt;
    return { ...this.metrics };
  }
}
export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new Error("Operation stopped."));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([promise, stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export class InvestigationError extends Error {
  constructor(
    cause: unknown,
    readonly investigation: InvestigationMetrics,
    readonly usage: MissionUsage
  ) {
    super(cause instanceof Error ? cause.message : "Investigation failed.", { cause });
  }
}
