import assert from "node:assert/strict";
import test from "node:test";
import type { AgentsApi, SessionRef } from "../../server/agents-api.js";
import { MissionUsageCollector } from "../../server/mission-usage.js";
import { finalizeRecordedAssessment } from "./finalize-assessment.js";

function fixture() {
  const usage = new MissionUsageCollector();
  usage.record("session:turn", null, "gpt-6-luna");
  const order: string[] = [];
  let reads = 0;
  const api: Pick<AgentsApi, "cancel" | "refreshUsage"> = {
    cancel: async () => {
      order.push("stop");
    },
    refreshUsage: async (_refs, signal) => {
      assert.equal(signal?.aborted, false);
      assert(order.includes("stop"));
      assert(!order.includes("delete"));
      order.push("read");
      if (++reads >= 2)
        usage.record(
          "session:turn",
          {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 5 },
          },
          "gpt-6-luna"
        );
    },
  };
  const refs: SessionRef[] = [
    {
      id: "session",
      turnId: "turn",
      role: "Mission Director",
      model: "gpt-6-luna",
      results: new Map(),
    },
  ];
  return {
    api,
    usage,
    refs,
    order,
    accountingDelayMs: 0,
    persist: () => {
      order.push("save");
    },
    cleanup: async () => {
      order.push("delete");
    },
  };
}

test("terminal validation stops, reconciles late usage, saves per-turn evidence, then deletes", async () => {
  const f = fixture();
  let saved = false;
  const result = await finalizeRecordedAssessment({
    ...f,
    persist: (evidence) => {
      f.persist();
      assert.equal(evidence.accounting.summary.totalTokens, 120);
      assert.equal(evidence.accounting.summary.accountingPending, false);
      assert.deepEqual(evidence.usageSnapshot.missing, []);
      assert.equal(evidence.usageSnapshot.samples.length, 1);
      saved = true;
    },
    cleanup: async () => {
      assert(saved);
      await f.cleanup();
    },
  });
  assert.deepEqual(f.order, ["stop", "read", "read", "save", "delete"]);
  assert.equal(result.accounting.attempts, 2);
  assert.equal(result.cleanupError, undefined);
});

test("pending usage survives deletion as saved evidence rather than a zero final cost", async () => {
  const f = fixture();
  f.api.refreshUsage = async () => {
    f.order.push("read");
  };
  const result = await finalizeRecordedAssessment({
    ...f,
    persist: (evidence) => {
      assert.deepEqual(evidence.usageSnapshot.missing, ["session:turn"]);
      assert.equal(evidence.accounting.summary.estimatedCostUsd, undefined);
      f.persist();
    },
  });
  assert.equal(result.accounting.attempts, 4);
  assert.equal(result.accounting.summary.accountingPending, true);
  assert.deepEqual(f.order.slice(-2), ["save", "delete"]);
});

test("unconfirmed stop cannot produce a final total even if usage arrives; peers are stopped", async () => {
  const f = fixture();
  f.refs.push({ ...f.refs[0], id: "peer" });
  f.api.cancel = async (ref) => {
    f.order.push("stop");
    if (ref.id === "session") throw new Error("stop deadline");
  };
  const result = await finalizeRecordedAssessment(f);
  assert.deepEqual(
    result.stops.map((s) => s.confirmed),
    [false, true]
  );
  assert.equal(result.accounting.summary.accountingPending, true);
  assert.equal(result.accounting.summary.estimatedCostUsd, undefined);
  assert(result.accounting.summary.knownEstimatedCostUsd! > 0);
  assert.match(result.accounting.error!, /unresolved stop/);
  assert.equal(f.order.at(-1), "delete");
});

test("hung accounting is bounded, receives an abort, and still saves and cleans up", async () => {
  const f = fixture();
  let observedSignal: AbortSignal | undefined;
  f.api.refreshUsage = async (_refs, signal) => {
    observedSignal = signal;
    return new Promise(() => {});
  };
  const result = await finalizeRecordedAssessment({ ...f, accountingMilliseconds: 20 });
  assert.equal(observedSignal?.aborted, true);
  assert.equal(result.accounting.attempts, 1);
  assert.equal(result.accounting.summary.accountingPending, true);
  assert.match(result.accounting.error!, /deadline/);
  assert.deepEqual(f.order, ["stop", "save", "delete"]);
});

test("persistence failure still attempts resource deletion and surfaces both errors", async () => {
  const f = fixture();
  const result = await finalizeRecordedAssessment({
    ...f,
    persist: () => {
      f.order.push("save");
      throw new Error("disk full");
    },
    cleanup: async () => {
      f.order.push("delete");
      throw new Error("delete rejected");
    },
  });
  assert.match(result.evidenceError!, /disk full/);
  assert.match(result.cleanupError!, /delete rejected/);
  assert.deepEqual(f.order.slice(-2), ["save", "delete"]);
});

test("unknown session or turn identity stays explicit and cannot claim complete accounting", async () => {
  for (const ref of [
    { id: undefined, turnId: undefined },
    { id: "session", turnId: undefined },
  ]) {
    const f = fixture();
    Object.assign(f.refs[0], ref);
    f.api.refreshUsage = async () => {};
    const result = await finalizeRecordedAssessment(f);
    assert.equal(result.unidentifiedTurns.length, 1);
    assert.equal(result.accounting.summary.accountingPending, true);
    assert.equal(result.accounting.summary.estimatedCostUsd, undefined);
    if (!ref.id) assert.equal(result.stops[0].confirmed, false);
    assert.equal(f.order.at(-1), "delete");
  }
});

test("pre-stop usage cannot masquerade as final when the stopped turn is missing from listings", async () => {
  const f = fixture();
  f.usage.record(
    "session:turn",
    {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 5 },
    },
    "gpt-6-luna"
  );
  const known = f.usage.summary().estimatedCostUsd;
  assert.equal(f.usage.summary().accountingPending, false);
  f.api.refreshUsage = async () => {};
  const result = await finalizeRecordedAssessment(f);
  assert.equal(result.accounting.summary.accountingPending, true);
  assert.equal(result.accounting.summary.estimatedCostUsd, undefined);
  assert.equal(result.accounting.summary.knownEstimatedCostUsd, known);
  assert.deepEqual(result.usageSnapshot.missing, ["session:turn"]);
});
