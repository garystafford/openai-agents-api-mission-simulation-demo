import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadManifest, loadCase, directory, type DatasetManifest } from "./dataset.js";
import { actionOracle } from "./oracle.js";
import { missionEvidence, connectMissionMcp } from "../../server/mission-evidence.js";
import { parseArguments } from "../../server/agent-schemas.js";
import { prepareReplay, replayContext } from "./replay.js";
import { missionRulesVersion } from "../../server/mission-rules.js";
import { specialistNames } from "../../server/mission-team.js";
import { specialistAdviceSchema } from "../../server/agent-schemas.js";
import { reviewedSource, type SourceReview } from "./review-binding.js";
import { gradeEpisode } from "./assertions.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url));
const hash = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const manifest = loadManifest();
assert.equal(manifest.version, 4);
assert.equal(manifest.sourceKind, "derived_replay");
assert.equal(
  manifest.referenceStatus,
  "draft_awaiting_gpt_6_1_high_reference_generation_and_review"
);
assert.equal(manifest.rulesVersion, missionRulesVersion);
assert.equal(manifest.sourceDatasetSha256, hash(read("./history/v3/dataset.json")));
assert.equal(JSON.parse(read("./execution-policy.json").toString()).status, "on_hold");
// Earlier datasets remain immutable historical evidence.
for (const version of [1, 2, 3]) {
  const old: DatasetManifest = JSON.parse(read(`./history/v${version}/dataset.json`).toString());
  for (const entry of old.cases)
    assert.equal(hash(read(`./history/v${version}/` + entry.file)), entry.sha256);
}
const collection = JSON.parse(read("./collection.json").toString());
const reviews: { cases: Record<string, SourceReview> } = JSON.parse(
  read("./source-reviews.json").toString()
);
const checks = JSON.parse(read("./review.json").toString());
assert.equal(Object.keys(reviews.cases).length, 50);
assert.equal(checks.cases.length, 50);
assert.equal(
  checks.cases.filter((item: { selectedForDataset: boolean }) => item.selectedForDataset).length,
  45
);
assert.equal(collection.complete, true);
assert.equal(collection.revision, manifest.collectionRevision);
assert.equal(
  collection.workingTreeDirty,
  false,
  "Collection must start from the requested clean commit."
);
assert.equal(collection.rows.length, 10);
assert.equal(
  new Set(
    collection.rows.map(
      (row: { scenario: string; variant: string }) => row.scenario + ":" + row.variant
    )
  ).size,
  10
);
for (const row of collection.rows) {
  assert.equal(row.status, "collected");
  assert.equal(row.sessionsDeleted, true);
  assert.ok(row.recordIds.length >= 5);
}
assert.equal(new Set(checks.cases.map((check: { id: string }) => check.id)).size, 50);
for (const check of checks.cases) {
  const review = reviews.cases[check.id];
  assert.equal(check.sourceRecordId, review.recordId);
  assert.equal(check.sourceOutputSha256, review.outputSha256);
  assert.equal(check.sourceVerdict, review.verdict);
  assert.ok(
    collection.rows.some((row: { recordIds: string[] }) => row.recordIds.includes(review.recordId))
  );
  const path = resolve(directory, manifest.recordingDirectory, review.recordId + ".json");
  if (existsSync(path)) reviewedSource(JSON.parse(readFileSync(path, "utf8")), review);
}
assert.equal(manifest.cases.length, 45);
assert.equal(new Set(manifest.cases.map((item) => item.id)).size, 45);
for (const role of [
  "Mission Director",
  "Power & Thermal",
  "Life Support",
  "Weather & Navigation",
  "Risk Review",
]) {
  const entries = manifest.cases.filter((entry) => entry.role === role);
  assert.equal(entries.length, 9, role);
  assert.equal(new Set(entries.map((entry) => entry.scenario)).size, 5);
  assert.equal(new Set(entries.map((entry) => loadCase(entry.id).record.state.missionId)).size, 9);
}
const checkedEvidence = new Set<string>();
for (const entry of manifest.cases) {
  const item = loadCase(entry.id);
  assert.equal(hash(read("./" + entry.file)), entry.sha256, "Case hash: " + entry.id);
  assert.equal(hash(JSON.stringify(item.record, null, 2) + "\n"), entry.sourceRecordSha256);
  const rawPath = resolve(directory, manifest.recordingDirectory, item.record.id + ".json");
  if (existsSync(rawPath))
    assert.deepEqual(
      item.record,
      JSON.parse(readFileSync(rawPath, "utf8")),
      "Raw recording drift: " + entry.id
    );
  assert.deepEqual(item.replay, prepareReplay(item.record), "Derived replay drift: " + item.id);
  const historical = JSON.parse(read("./history/v3/" + entry.file).toString());
  assert.deepEqual(item.record, historical.record, "Historical source rewritten");
  assert.deepEqual(item.fixedReports, historical.fixedReports, "Historical reports rewritten");
  assert.equal(item.record.role, entry.role);
  assert.ok(item.record.sessionId && item.record.turnId && item.record.output);
  assert.equal(item.record.continuing, false);
  assert.equal(item.record.error, undefined);
  assert.equal(item.record.state.simulation.elapsedMinutes, 0);
  const row = collection.rows.find(
    (row: { missionId: string }) => row.missionId === item.record.state.missionId
  );
  assert.ok(row?.recordIds.includes(item.record.id));
  assert.equal(row.scenario, entry.scenario);
  assert.equal(row.variant, entry.variant);
  assert.equal(item.review.status, "agent_reviewed");
  const source = reviewedSource(item.record, reviews.cases[item.id]);
  assert.equal(item.review.sourceRecordId, source.recordId);
  assert.equal(item.review.sourceOutputSha256, source.outputSha256);
  assert.equal(item.review.sourceVerdict, source.verdict);
  assert.equal(item.review.sourceReview, source.note);
  assert.ok(
    checks.cases.find(
      (check: { id: string; selectedForDataset: boolean }) =>
        check.id === item.id && check.selectedForDataset
    )
  );
  const sourceEpisode = JSON.stringify({
    answer: JSON.parse(item.record.output),
    tools: item.record.tools.map(({ call, result }) => ({
      name: call.name,
      arguments: parseArguments(call),
      success: result === null || result.success,
      ...(result?.success ? { output: result.output } : {}),
    })),
  });
  assert.deepEqual(
    checks.cases.find((check: { id: string }) => check.id === item.id).deterministicSourceCheck,
    gradeEpisode(sourceEpisode, item)
  );
  assert.equal(Object.keys(item.fixedReports).length, 4);
  if (existsSync(rawPath)) {
    const sourceRecords = row.recordIds.map((id: string) =>
      JSON.parse(
        readFileSync(resolve(directory, manifest.recordingDirectory, id + ".json"), "utf8")
      )
    );
    for (const name of specialistNames) {
      const report = sourceRecords.find(
        (record: { role: string; continuing: boolean; error?: string }) =>
          record.role === name && !record.continuing && !record.error
      );
      assert.ok(report, "Missing actual specialist report: " + name);
      assert.deepEqual(
        item.fixedReports[name],
        specialistAdviceSchema.parse(JSON.parse(report.output))
      );
    }
  }
  const director = entry.role === "Mission Director";
  const state = replayContext(item).state;
  assert.deepEqual(item.review.facts[0], missionEvidence(state));
  if (director) {
    const oracle = actionOracle(state);
    assert.deepEqual(item.review.acceptableActionSets, oracle.acceptable);
    assert.equal(item.review.bestAchievableUnmet, oracle.bestAchievableUnmet);
    assert.equal(
      item.review.objectiveFeasibility,
      oracle.feasible ? "feasible" : "infeasible_under_action_catalog"
    );
    assert(oracle.outcomes.every((o) => Math.abs(o.elapsedMinutes - o.horizonMinutes) < 1e-8));
  } else {
    const key = state.missionId + ":" + JSON.stringify(item.record.tools.map((t) => t.call));
    if (checkedEvidence.has(key)) continue;
    checkedEvidence.add(key);
    const mcp = await connectMissionMcp(state);
    try {
      for (const { call, result } of item.record.tools) {
        if (!result?.success) continue;
        const actual = await mcp.callTool({
          name: call.name,
          arguments: parseArguments(call) as Record<string, unknown>,
        });
        assert.ok(!actual.isError, "Current evidence tool failed: " + entry.id);
        if (call.name === "mcp_read_mission_telemetry") {
          const text = (
            actual as { content?: Array<{ type: string; text?: string }> }
          ).content?.find((block) => block.type === "text");
          assert.ok(text && "text" in text);
          const evidence = JSON.parse(text.text as string);
          assert.deepEqual(evidence.responseWindow, missionEvidence(state).responseWindow);
          assert.deepEqual(
            evidence.recallPrerequisites,
            missionEvidence(state).recallPrerequisites
          );
          assert.deepEqual(evidence.authorization, missionEvidence(state).authorization);
        }
      }
    } finally {
      await mcp.close();
    }
  }
}
console.log(
  "Verified v4: 45 derived current-contract replays, 9 per agent; original v3 recordings and reports preserved, source hashes and reviews bound, current evidence and common-deadline oracles validated. v1/v2/v3 archives unchanged. Source and derived-input provenance validated. Reference readiness is tracked separately in references/index.json. Paid comparison remains on hold."
);
