import type { AgentsApi, SessionRef } from "../../server/agents-api.js";
import type { MissionUsageCollector } from "../../server/mission-usage.js";
import { settleAccounting } from "./accounting.js";

type Finalization = {
  stops: Array<{
    sessionId?: string;
    turnId?: string;
    role?: string;
    confirmed: boolean;
    error?: string;
  }>;
  accounting: Awaited<ReturnType<typeof settleAccounting>>;
  usageSnapshot: ReturnType<MissionUsageCollector["snapshot"]>;
  unidentifiedTurns: Array<{ sessionId?: string; role?: string }>;
};

// Terminal validation cleanup only: never use this while awaiting a real user's approval.
export async function finalizeRecordedAssessment(options: {
  api: Pick<AgentsApi, "cancel" | "refreshUsage">;
  usage: MissionUsageCollector;
  refs: SessionRef[];
  persist: (evidence: Finalization) => void | Promise<void>;
  cleanup: () => Promise<void>;
  accountingMilliseconds?: number;
  accountingDelayMs?: number;
}) {
  const milliseconds = options.accountingMilliseconds ?? 30000;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0)
    throw new Error("Accounting deadline must be positive.");
  const stops = await Promise.all(
    options.refs.map(async (ref) => {
      try {
        if (!ref.id) throw new Error("Session identity unknown; stop unconfirmed.");
        await options.api.cancel(ref);
        return { sessionId: ref.id, turnId: ref.turnId, role: ref.role, confirmed: true };
      } catch (error) {
        return {
          sessionId: ref.id,
          turnId: ref.turnId,
          role: ref.role,
          confirmed: false,
          error: String(error),
        };
      }
    })
  );
  for (const ref of options.refs)
    if (ref.id && ref.turnId)
      options.usage.requireReconciliation(ref.id + ":" + ref.turnId, ref.model);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Accounting reconciliation deadline reached.")),
    milliseconds
  );
  let accounting: Finalization["accounting"];
  try {
    accounting = await settleAccounting(
      () => options.api.refreshUsage(options.refs, controller.signal),
      () => options.usage.summary(),
      { signal: controller.signal, delayMs: options.accountingDelayMs }
    );
  } finally {
    clearTimeout(timer);
  }
  const unidentifiedTurns = options.refs
    .filter((ref) => !ref.id || !ref.turnId)
    .map((ref) => ({ sessionId: ref.id, role: ref.role }));
  if (stops.some((stop) => !stop.confirmed) || unidentifiedTurns.length) {
    accounting = {
      ...accounting,
      error: [
        accounting.error,
        "Final usage cannot be confirmed: unresolved stop or turn identity.",
      ]
        .filter(Boolean)
        .join(" "),
      summary: { ...accounting.summary, accountingPending: true, estimatedCostUsd: undefined },
    };
  }
  const evidence: Finalization = {
    stops,
    accounting,
    usageSnapshot: options.usage.snapshot(),
    unidentifiedTurns,
  };
  let evidenceError: string | undefined, cleanupError: string | undefined;
  try {
    await options.persist(evidence);
  } catch (error) {
    evidenceError = String(error);
  } finally {
    // Best-effort resource cleanup still runs after accounting/persistence failures.
    try {
      await options.cleanup();
    } catch (error) {
      cleanupError = String(error);
    }
  }
  return { ...evidence, evidenceError, cleanupError };
}
