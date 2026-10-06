import { abortable } from "../../server/investigation-budget.js";
import type { MissionUsage } from "../../server/mission-contract.js";

// Read-only accounting polls, never a candidate retry or new model turn.
export async function settleAccounting(
  refresh: () => Promise<void>,
  snapshot: () => MissionUsage,
  options: {
    retries?: number;
    delayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
  } = {}
) {
  const retries = options.retries ?? 3;
  if (!Number.isInteger(retries) || retries < 0 || retries > 3)
    throw new Error("Invalid accounting retry bound");
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let error: string | undefined;
  let summary = snapshot();
  let attempts = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (options.signal?.aborted) {
      error = String(options.signal.reason);
      break;
    }
    attempts++;
    try {
      await abortable(refresh(), options.signal);
      error = undefined;
    } catch (failure) {
      error = String(failure);
    }
    summary = snapshot();
    if (options.signal?.aborted) {
      error = String(options.signal.reason);
      break;
    }
    if (!error && !summary.accountingPending) break;
    if (attempt < retries) {
      try {
        await abortable(sleep(options.delayMs ?? 2000), options.signal);
      } catch (failure) {
        error = String(failure);
        break;
      }
    }
  }
  return {
    summary: error ? { ...summary, accountingPending: true, estimatedCostUsd: undefined } : summary,
    error,
    attempts,
  };
}
