import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { directory, type ReviewedCase } from "./dataset.js";
import { sha256 } from "./saved-comparison.js";

export type FocusedProfile = { model: string; effort: "low" | "medium" | "high" };
export type FocusedFixture = { item: ReviewedCase; rubric: string; sha256: string };
export function focusedDirectory() {
  const run = process.env.MARS_FOCUSED_RUN;
  assert(run && /^focused-models-[0-9TZ-]+$/.test(run), "Bounded focused run required");
  return resolve(directory, "results", run);
}
export function focusedFixtures(): FocusedFixture[] {
  return JSON.parse(readFileSync(resolve(focusedDirectory(), "fixtures.json"), "utf8"));
}
export function focusedPlan() {
  return JSON.parse(readFileSync(resolve(focusedDirectory(), "plan.snapshot.json"), "utf8"));
}
export function candidateKey(caseId: string, profile: FocusedProfile) {
  return caseId + "::" + profile.model + ":" + profile.effort;
}
export function validateFocusedClaim(
  scope: {
    runId: string;
    expiresAt: string;
    maxCalls: number;
    estimatedBudgetUsd: number;
    records: { key: string; fixtureSha256: string; reservationUsd: number }[];
  },
  key: string,
  fixtureSha256: string,
  events: { phase: string; key: string; reservationUsd?: number; chargedEstimateUsd?: number }[],
  runId: string | undefined,
  now = Date.now()
) {
  assert.equal(runId, scope.runId, "Focused authorization run mismatch");
  assert(now < Date.parse(scope.expiresAt), "Focused authorization expired");
  assert([18, 54].includes(scope.maxCalls), "Unsupported focused matrix size");
  assert.equal(scope.records.length, scope.maxCalls);
  assert.equal(new Set(scope.records.map((row) => row.key)).size, scope.maxCalls);
  const row = scope.records.find((record) => record.key === key);
  assert(row, "Candidate is outside the focused matrix");
  assert.equal(row.fixtureSha256, fixtureSha256, "Candidate fixture changed");
  const started = events.filter((event) => event.phase === "started");
  assert(
    !started.some((event) => event.key === key),
    "Candidate already attempted; no automatic retries"
  );
  assert(started.length < scope.maxCalls, "Focused call limit reached");
  const committed = started.reduce((sum, event) => {
    const completed = events.find(
      (value) => value.phase === "completed" && value.key === event.key
    );
    return sum + (completed?.chargedEstimateUsd ?? event.reservationUsd ?? 2);
  }, 0);
  assert(
    committed + row.reservationUsd <= scope.estimatedBudgetUsd,
    "Focused estimated budget stop reached"
  );
  return row;
}
export function claimFocusedCandidate(
  policy: { focusedScope?: Parameters<typeof validateFocusedClaim>[0] },
  caseId: string,
  profile: FocusedProfile
) {
  assert(policy.focusedScope, "Missing focused candidate scope");
  const dir = focusedDirectory();
  const fixtures = focusedFixtures();
  const fixture = fixtures.find((value) => value.item.id === caseId);
  assert(fixture, "Unknown focused fixture");
  assert.equal(
    sha256(JSON.stringify({ item: fixture.item, rubric: fixture.rubric })),
    fixture.sha256
  );
  const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8"));
  for (const [path, hash] of Object.entries(manifest.sourceHashes))
    assert.equal(
      sha256(readFileSync(resolve(directory, "../..", path))),
      hash,
      "Frozen execution source changed: " + path
    );
  const journal = resolve(dir, "candidates.jsonl");
  const events = readFileSync(journal, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const key = candidateKey(caseId, profile);
  const row = validateFocusedClaim(
    policy.focusedScope,
    key,
    fixture.sha256,
    events,
    process.env.MARS_FOCUSED_RUN
  );
  appendFileSync(
    journal,
    JSON.stringify({
      phase: "started",
      key,
      startedAt: new Date().toISOString(),
      reservationUsd: row.reservationUsd,
    }) + "\n"
  );
  return { key, fixture, journal, reservationUsd: row.reservationUsd };
}
