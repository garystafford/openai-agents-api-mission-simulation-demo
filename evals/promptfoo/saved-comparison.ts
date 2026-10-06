import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { directory, loadCase, loadManifest } from "./dataset.js";

export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const rowSchema = z.object({
  id: z.string(),
  provider: z.object({ id: z.string() }),
  testCase: z.object({ vars: z.object({ caseId: z.string() }) }),
  response: z.object({ output: z.string() }),
  success: z.boolean(),
  failureReason: z.number(),
  gradingResult: z
    .object({
      componentResults: z.array(
        z
          .object({
            pass: z.boolean(),
            score: z.number(),
            reason: z.string(),
            assertion: z.object({ type: z.string() }),
          })
          .passthrough()
      ),
    })
    .passthrough(),
});
export type SavedRow = z.infer<typeof rowSchema>;

export function savedKey(row: SavedRow) {
  return row.testCase.vars.caseId + "::" + row.provider.id;
}

export function validateSavedRows(rows: SavedRow[]) {
  const manifest = loadManifest();
  const expected = new Set(
    manifest.cases.flatMap((entry) =>
      ["low", "medium", "high"].map((effort) => entry.id + "::gpt-6-luna:" + effort)
    )
  );
  assert.equal(rows.length, expected.size, "Incomplete saved sweep");
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, "Duplicate native row ID");
  for (const row of rows) {
    assert(expected.delete(savedKey(row)), "Duplicate or unknown saved case/provider pair");
    assert.equal(row.failureReason === 2, false, "Cannot regrade provider errors as answers");
    for (const kind of ["javascript", "llm-rubric"])
      assert.equal(
        row.gradingResult.componentResults.filter((c) => c.assertion.type === kind).length,
        1,
        "Missing or ambiguous original grading component"
      );
  }
  assert.equal(expected.size, 0);
}

// Read only. No client construction, sessions, environment credentials or evaluation calls.
export function loadSavedComparison() {
  const summary = JSON.parse(readFileSync(resolve(directory, "comparison.json"), "utf8"));
  const manifestBytes = readFileSync(resolve(directory, "dataset.json"));
  assert.equal(
    sha256(manifestBytes),
    summary.provenance.configSha256["dataset.json"],
    "Saved candidates belong to a different dataset"
  );
  for (const entry of loadManifest().cases)
    assert.equal(
      sha256(readFileSync(resolve(directory, entry.file))),
      entry.sha256,
      "Frozen case changed: " + entry.id
    );
  const path = resolve(directory, summary.rawResult.path);
  assert(
    path.startsWith(resolve(directory, "results") + "/"),
    "Raw export must remain local under results/"
  );
  const raw = readFileSync(path);
  assert.equal(sha256(raw), summary.rawResult.sha256, "Raw comparison export changed");
  const document = z
    .object({
      evalId: z.string(),
      results: z.object({ results: z.array(rowSchema) }),
    })
    .parse(JSON.parse(raw.toString()));
  assert.equal(document.evalId, summary.evalId, "Wrong source evaluation");
  const rows = document.results.results;
  validateSavedRows(rows);
  const bindings = new Map<string, { outputSha256: string; recordId: string }>(
    summary.records.map(
      (row: { caseId: string; provider: string; outputSha256: string; recordId: string }) => [
        row.caseId + "::" + row.provider,
        row,
      ]
    )
  );
  assert.equal(bindings.size, rows.length);
  for (const row of rows) {
    const binding = bindings.get(savedKey(row));
    assert(binding, "Missing original summary binding");
    assert.equal(row.id, binding.recordId, "Native row ID changed");
    assert.equal(
      sha256(row.response.output),
      binding.outputSha256,
      "Saved candidate output changed"
    );
    loadCase(row.testCase.vars.caseId);
  }
  return { evalId: document.evalId, rawResult: summary.rawResult, rows };
}
