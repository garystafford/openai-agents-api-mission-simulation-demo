import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { directory } from "./dataset.js";
import { sha256 } from "./saved-comparison.js";

// Rates verified October 4, 2026 against the official Sol model page.
export const calibrationRates = {
  input: 2,
  cachedInput: 0.2,
  cacheWrite: 2.5,
  output: 10,
  unit: "USD per million tokens; standard short-context",
  source: "https://developers.openai.com/api/docs/models/gpt-6-sol",
};
export function priceJudgeUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}) {
  const input = usage.input_tokens;
  const output = usage.output_tokens;
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const writes = usage.input_tokens_details?.cache_write_tokens ?? 0;
  for (const value of [input, output, cached, writes])
    assert(Number.isInteger(value) && value >= 0, "Invalid usage count");
  assert(cached + writes <= input, "Cache token categories exceed input");
  assert(input <= 272000, "Long-context request requires different pricing");
  return (
    ((input - cached - writes) * calibrationRates.input +
      cached * calibrationRates.cachedInput +
      writes * calibrationRates.cacheWrite +
      output * calibrationRates.output) /
    1e6
  );
}

export function reportJudgeCalibration(runDirectory: string) {
  const read = (name: string) => JSON.parse(readFileSync(resolve(runDirectory, name), "utf8"));
  const manifest = read("manifest.json");
  const timing = read("timing.json");
  const authorization = read("authorization.json");
  const snapshot = resolve(runDirectory, "anchors.snapshot.json");
  const anchorsBytes = readFileSync(
    existsSync(snapshot) ? snapshot : resolve(directory, "calibration/anchors.json")
  );
  assert.equal(
    sha256(anchorsBytes),
    manifest.anchorsSha256,
    "Calibration target labels changed after launch"
  );
  const anchors = JSON.parse(anchorsBytes.toString()).anchors as Array<{
    key: string;
    recordId: string;
    semanticVerdict: string;
    rationale: string;
    outputSha256: string;
  }>;
  const events = readFileSync(resolve(runDirectory, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const started = events.filter((event) => event.phase === "started");
  const completed = events.filter((event) => event.phase === "completed");
  assert.equal(started.length, 27, "Incomplete or excess judge-call attempts");
  assert.equal(completed.length, 27, "Incomplete calibration responses");
  assert.equal(new Set(started.map((row) => row.key)).size, 27);
  assert.equal(new Set(completed.map((row) => row.key)).size, 27);
  const native = read("promptfoo.json");
  const nativeRows = native.results.results;
  assert.equal(nativeRows.length, 27);
  const records = anchors.map((anchor) => {
    const event = completed.find((row) => row.key === anchor.key);
    assert(event, "Missing reviewed example");
    const claim = started.find((row) => row.key === anchor.key);
    assert.equal(
      sha256(readFileSync(resolve(runDirectory, claim.promptFile), "utf8").replace(/\n$/, "")),
      claim.promptSha256
    );
    const authorized = authorization.judgeScope.records.find(
      (row: { key: string }) => row.key === anchor.key
    );
    assert.equal(authorized.outputSha256, anchor.outputSha256);
    const nativeRow = nativeRows.find(
      (row: { testCase: { vars: { savedKey: string } } }) =>
        row.testCase.vars.savedKey === anchor.key
    );
    assert(nativeRow, "Missing native Promptfoo result");
    assert.equal(
      sha256(nativeRow.response.output),
      anchor.outputSha256,
      "Saved candidate output changed"
    );
    assert.equal(nativeRow.testCase.metadata.originalRecordId, anchor.recordId);
    const semantic = nativeRow.gradingResult.componentResults.find(
      (row: { assertion: { type: string } }) => row.assertion.type === "llm-rubric"
    );
    const deterministic = nativeRow.gradingResult.componentResults.find(
      (row: { assertion: { type: string } }) => row.assertion.type === "javascript"
    );
    const verdict = event.semanticVerdict?.toLowerCase() ?? "judge_error";
    let reason = event.error ?? event.response?.error;
    if (event.response?.output) {
      try {
        reason = JSON.parse(event.response.output).reason;
      } catch {
        reason = "Malformed judge response: " + String(event.response.output);
      }
    }
    if (["pass", "fail", "needs_review"].includes(verdict))
      assert.equal(semantic.reason, reason, "Native result and recorded judge disagree");
    const usage = event.response?.raw?.usage;
    const cost = usage ? priceJudgeUsage(usage) : null;
    if (event.response?.raw) {
      assert.equal(event.response.raw.model, "gpt-6-sol");
      assert.equal(event.response.raw.service_tier, "default");
    }
    return {
      key: anchor.key,
      originalRecordId: anchor.recordId,
      outputSha256: anchor.outputSha256,
      expected: anchor.semanticVerdict,
      judge: verdict,
      agreement: verdict === anchor.semanticVerdict,
      reason,
      reviewedRationale: anchor.rationale,
      elapsedMs: event.elapsedMs,
      responseId: event.response?.raw?.id,
      usage,
      estimatedUsd: cost,
      nativeEpisodePassed: nativeRow.success,
      deterministicPassed: deterministic.pass,
    };
  });
  const confusion = Object.fromEntries(
    ["pass", "fail"].map((expected) => [
      expected,
      Object.fromEntries(
        ["pass", "fail", "needs_review", "judge_error"].map((verdict) => [
          verdict,
          records.filter((row) => row.expected === expected && row.judge === verdict).length,
        ])
      ),
    ])
  );
  const sortedLatencies = records.map((row) => row.elapsedMs).sort((a, b) => a - b);
  const total = (field: "input_tokens" | "output_tokens") =>
    records.reduce((sum, row) => sum + (row.usage?.[field] ?? 0), 0);
  const summary = {
    runId: manifest.runId,
    evalId: native.evalId,
    gradingVersion: manifest.gradingVersion,
    sourceEvalId: manifest.sourceEvalId,
    model: manifest.model,
    reasoning: manifest.reasoning,
    candidateCalls: 0,
    judgeAttempts: started.length,
    completed: records.length,
    agreements: records.filter((row) => row.agreement).length,
    agreementPct: (records.filter((row) => row.agreement).length / records.length) * 100,
    falseAcceptances: records.filter((row) => row.expected === "fail" && row.judge === "pass")
      .length,
    falseRejections: records.filter((row) => row.expected === "pass" && row.judge === "fail")
      .length,
    disagreementQualification:
      "False acceptance/rejection counts are relative to frozen development labels; disagreement does not establish whether the judge or reviewed label is wrong. See JUDGE_CALIBRATION.md for substantive review.",
    abstentions: records.filter((row) => row.judge === "needs_review").length,
    judgeErrors: records.filter((row) => row.judge === "judge_error").length,
    confusion,
    timing: {
      ...timing,
      medianCallMs: sortedLatencies[13],
      p95CallMs: sortedLatencies[25],
      minCallMs: sortedLatencies[0],
      maxCallMs: sortedLatencies[26],
    },
    usage: {
      inputTokens: total("input_tokens"),
      outputTokens: total("output_tokens"),
      cachedInputTokens: records.reduce(
        (sum, row) => sum + (row.usage?.input_tokens_details?.cached_tokens ?? 0),
        0
      ),
      cacheWriteTokens: records.reduce(
        (sum, row) => sum + (row.usage?.input_tokens_details?.cache_write_tokens ?? 0),
        0
      ),
      reasoningTokensIncludedInOutput: records.reduce(
        (sum, row) => sum + (row.usage?.output_tokens_details?.reasoning_tokens ?? 0),
        0
      ),
    },
    estimatedUsd: records.reduce((sum, row) => sum + (row.estimatedUsd ?? 0), 0),
    usageRecordsMissing: records.filter((row) => row.estimatedUsd === null).length,
    rates: calibrationRates,
    costQualification:
      "Computed from all raw response usage at verified standard rates, including cache writes. Not an invoice; excludes prior runs and Codex usage. Native provider returned no cost field for this model.",
    limitation:
      "One attempt on 27 deliberately selected development anchors, reviewed by Codex; not independent human labels, held-out accuracy or repeated judge stability.",
    paidStatus: JSON.parse(readFileSync(resolve(directory, "execution-policy.json"), "utf8"))
      .status,
    sourceHashes: Object.fromEntries(
      ["manifest.json", "authorization.json", "calls.jsonl", "promptfoo.json", "timing.json"].map(
        (file) => [file, sha256(readFileSync(resolve(runDirectory, file)))]
      )
    ),
    disagreements: records.filter((row) => !row.agreement),
    records,
  };
  assert.equal(summary.paidStatus, "on_hold");
  writeFileSync(
    resolve(directory, "calibration/judge-calibration.json"),
    JSON.stringify(summary, null, 2) + "\n"
  );
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv[2], "Provide the saved calibration run directory");
  const summary = reportJudgeCalibration(resolve(process.argv[2]));
  console.log(JSON.stringify(summary, (key, value) => (key === "records" ? undefined : value), 2));
}
