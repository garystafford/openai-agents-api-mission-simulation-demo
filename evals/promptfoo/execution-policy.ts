import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type PaidOperation = "candidate" | "judge";

export function assertOperationReleased(
  policy: { status: string; reason: string; allowedOperations?: string[] },
  operation: PaidOperation
) {
  if (policy.status !== "released")
    throw new Error("Paid Promptfoo comparison is disabled: " + policy.reason);
  if (!policy.allowedOperations?.includes(operation))
    throw new Error("Paid Promptfoo operation is not authorized: " + operation);
}

export function assertComparisonReleased(operation: PaidOperation = "candidate") {
  // A bounded judge child may run alongside the separately authorized mission collector.
  // This permit can never release candidate calls or alter the collector's policy.
  if (operation === "judge" && process.env.MARS_JUDGE_AUTHORIZATION_FILE) {
    const runId = process.env.MARS_JUDGE_CALIBRATION_RUN;
    assert(
      runId && /^judge-(calibration|regrade|validation|adjudication|focused)-[0-9TZ-]+$/.test(runId)
    );
    const expected = resolve(
      fileURLToPath(new URL("./results/", import.meta.url)),
      runId,
      "authorization.json"
    );
    assert.equal(
      resolve(process.env.MARS_JUDGE_AUTHORIZATION_FILE),
      expected,
      "Judge permit must belong to its run"
    );
    const policy = JSON.parse(readFileSync(expected, "utf8"));
    assert.equal(policy.judgeScope?.runId, runId);
    assertOperationReleased(policy, operation);
    return policy;
  }
  const policy = JSON.parse(
    readFileSync(new URL("./execution-policy.json", import.meta.url), "utf8")
  );
  assertOperationReleased(policy, operation);
  return policy;
}
