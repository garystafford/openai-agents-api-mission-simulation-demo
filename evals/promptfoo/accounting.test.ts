import assert from "node:assert/strict";
import test from "node:test";
import { MissionUsageCollector } from "../../server/mission-usage.js";
import { settleAccounting } from "./accounting.js";

test("late accounting replaces a missing turn before session cleanup without a candidate retry", async () => {
  const collector = new MissionUsageCollector();
  collector.record("turn", null, "gpt-6-luna");
  let calls = 0;
  const result = await settleAccounting(
    async () => {
      if (++calls === 3)
        collector.record(
          "turn",
          {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
            input_tokens_details: { cached_tokens: 10 },
            output_tokens_details: { reasoning_tokens: 5 },
          },
          "gpt-6-luna"
        );
    },
    () => collector.summary(),
    { sleep: async () => {} }
  );
  assert.equal(calls, 3);
  assert.equal(result.summary.accountingPending, false);
  assert.equal(result.summary.totalTokens, 120);
  assert(result.summary.estimatedCostUsd! > 0);
});

test("accounting outages stay pending with no invented zero charge and bounded read attempts", async () => {
  const collector = new MissionUsageCollector();
  let calls = 0;
  const result = await settleAccounting(
    async () => {
      calls++;
      throw new Error("read outage");
    },
    () => collector.summary(),
    { sleep: async () => {} }
  );
  assert.equal(calls, 4);
  assert.equal(result.summary.accountingPending, true);
  assert.equal(result.summary.estimatedCostUsd, undefined);
  assert.match(result.error!, /read outage/);
});

test("accounting cancellation prevents further read attempts", async () => {
  const collector = new MissionUsageCollector();
  const controller = new AbortController();
  controller.abort(new Error("accounting deadline"));
  let calls = 0;
  const result = await settleAccounting(
    async () => {
      calls++;
    },
    () => collector.summary(),
    { signal: controller.signal, sleep: async () => {} }
  );
  assert.equal(calls, 0);
  assert.equal(result.summary.accountingPending, true);
  assert.equal(result.summary.estimatedCostUsd, undefined);
});
