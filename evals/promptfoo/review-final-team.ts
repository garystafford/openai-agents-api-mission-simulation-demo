// Offline diagnostic review; preserve raw tool results and identify schema violations.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { arithmeticSchema } from "../../server/mission-arithmetic.js";
import { directory } from "./dataset.js";
const run = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(resolve(run, "manifest.json"), "utf8"));
assert.equal(manifest.mode, "final-team-smoke");
assert(
  manifest.rows.every((row: { status: string }) => row.status !== "running"),
  "Wait for collection to finish before final trace review"
);
const records = manifest.rows.flatMap((row: { recordIds: string[] }) =>
  row.recordIds.map((id) => JSON.parse(readFileSync(resolve(run, id + ".json"), "utf8")))
);
const errors: unknown[] = [];
const arithmetic: unknown[] = [];
const roles: Record<string, { episodes: number; errors: number; milliseconds: number[] }> = {};
for (const record of records) {
  const role = (roles[record.role] ??= { episodes: 0, errors: 0, milliseconds: [] });
  role.episodes++;
  role.milliseconds.push(record.elapsedMs);
  if (record.error) role.errors++;
  for (const [index, tool] of record.tools.entries()) {
    if (tool.result?.success === false)
      errors.push({
        recordId: record.id,
        scenario: record.state.scenario.id,
        role: record.role,
        toolIndex: index,
        name: tool.call.name,
        error: tool.result.error,
      });
    if (tool.call.name !== "mcp_check_arithmetic") continue;
    const args =
      typeof tool.call.arguments === "string"
        ? JSON.parse(tool.call.arguments)
        : tool.call.arguments;
    const parsed = arithmeticSchema.safeParse(args);
    arithmetic.push({
      recordId: record.id,
      scenario: record.state.scenario.id,
      role: record.role,
      toolIndex: index,
      success: tool.result?.success === true,
      validArguments: parsed.success,
      violations: parsed.success
        ? []
        : parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  }
}
const report = {
  runId: manifest.runId,
  method:
    "Offline source-schema validation and trace inspection; no semantic judge or independent human review",
  roles,
  failedToolCalls: errors,
  arithmetic,
};
writeFileSync(
  resolve(directory, "final-team-trace-review.json"),
  JSON.stringify(report, null, 2) + "\n"
);
console.log(JSON.stringify(report, null, 2));
