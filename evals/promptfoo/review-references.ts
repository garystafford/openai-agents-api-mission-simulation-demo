import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCase, loadManifest, directory } from "./dataset.js";
import {
  referenceRequest,
  sha256,
  atomicJson,
  type ReferenceRecord,
  referenceModel,
  referenceEffort,
} from "./references.js";
import { replayContext } from "./replay.js";
import { directorToolHandler } from "./provider.js";
import type { FunctionCall } from "../../server/agents-api.js";
import { gradeEpisode } from "./assertions.js";
import { actionOracle, evaluateActionSet } from "./oracle.js";
import { checkArithmetic, arithmeticSchema } from "../../server/mission-arithmetic.js";
import { connectMissionMcp, missionEvidence } from "../../server/mission-evidence.js";
import { decisionPlanSchema, specialistAdviceSchema } from "../../server/agent-schemas.js";
import type { MissionAction } from "../../server/mission-contract.js";

type SemanticReview = {
  outputSha256: string;
  verdict: "accepted" | "accepted_with_caveats" | "needs_correction";
  note: string;
  findings: string[];
  // Optional independently checked edits; never replace the generated draft.
  adjudicatedAnswer?: unknown;
  adjudication?: string;
};
export function bindReferenceReview(
  record: Pick<ReferenceRecord, "caseId" | "episode">,
  review: SemanticReview
) {
  if (!record.episode || review.outputSha256 !== sha256(JSON.stringify(record.episode.answer)))
    throw new Error("Review must bind to the exact generated answer: " + record.caseId);
  if (
    !review.note.trim() ||
    !Array.isArray(review.findings) ||
    !["accepted", "accepted_with_caveats", "needs_correction"].includes(review.verdict)
  )
    throw new Error("Substantive review required: " + record.caseId);
  if (review.adjudicatedAnswer !== undefined && !review.adjudication?.trim())
    throw new Error("Adjudication must explain its evidence: " + record.caseId);
  return review;
}
function textContent(value: unknown): string {
  const content = (value as { content?: Array<{ type: string; text?: string }> }).content;
  return (
    content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n") ?? ""
  );
}
async function main() {
  const root = resolve(process.argv[2] ?? "");
  if (!root.startsWith(join(directory, "references") + "/"))
    throw new Error("Pass a reference batch directory.");
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const dataset = loadManifest();
  const datasetHash = sha256(readFileSync(join(directory, "dataset.json")));
  assert.equal(manifest.datasetSha256, datasetHash);
  assert.equal(manifest.model, referenceModel);
  assert.equal(manifest.effort, referenceEffort);
  assert.equal(manifest.rows.length, 45);
  assert.equal(manifest.status, "generated_awaiting_review");
  const ledgerPath = join(root, "semantic-reviews.json");
  const ledger: { reviewer: string; cases: Record<string, SemanticReview> } | undefined =
    existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : undefined;
  const checks = [];
  for (const entry of dataset.cases) {
    const row = manifest.rows.find((row: { caseId: string }) => row.caseId === entry.id);
    assert.ok(row);
    const bytes = readFileSync(join(root, row.file));
    assert.equal(sha256(bytes), row.sha256);
    const record: ReferenceRecord = JSON.parse(bytes.toString());
    const item = loadCase(entry.id);
    assert.equal(record.caseId, entry.id);
    assert.equal(record.datasetSha256, datasetHash);
    assert.equal(record.caseSha256, entry.sha256);
    assert.deepEqual(record.request, JSON.parse(JSON.stringify(referenceRequest(item))));
    assert.equal(record.model, referenceModel);
    assert.equal(record.effort, referenceEffort);
    assert.equal(record.error, undefined);
    assert.ok(record.episode);
    assert.equal(record.cleanup.sessionDeleted, true);
    assert.equal(record.cleanup.mcpClosed, true);
    assert.equal(record.cleanup.errors.length, 0);
    const structural = gradeEpisode(JSON.stringify(record.episode), item);
    assert.deepEqual(record.structuralCheck, structural);
    const state = replayContext(item).state;
    const oracle = actionOracle(state);
    const handleDirector =
      entry.role === "Mission Director" ? directorToolHandler(item) : undefined;
    const arithmetic = [];
    const offlineArithmeticRecovery = [];
    let mcp: Awaited<ReturnType<typeof connectMissionMcp>> | undefined;
    try {
      if (entry.role !== "Mission Director") mcp = await connectMissionMcp(state);
      for (const tool of record.episode.tools) {
        if (handleDirector) {
          const reply = await handleDirector({
            type: "function_call",
            name: tool.name,
            arguments: tool.arguments as FunctionCall["arguments"],
            call_id: "offline-review",
            turn_id: "offline-review",
          });
          assert.equal(tool.success, reply === null || reply.success);
          if (reply?.success)
            assert.deepEqual(JSON.parse(tool.output as string), JSON.parse(reply.output as string));
          else if (reply) assert.equal(tool.error, reply.error);
          continue;
        }
        if (!tool.success) {
          if (tool.name === "mcp_check_arithmetic") {
            const validation = arithmeticSchema.safeParse(tool.arguments);
            const input = tool.arguments as {
              calculations?: Array<{ label: string; terms: number[][]; divisor?: number }>;
            };
            const numericalChecks = [];
            if (Array.isArray(input.calculations)) {
              for (let offset = 0; offset < input.calculations.length; offset += 8)
                numericalChecks.push(
                  checkArithmetic({
                    calculations: input.calculations
                      .slice(offset, offset + 8)
                      .map((calculation) => ({
                        ...calculation,
                        label: calculation.label.slice(0, 100),
                      })),
                  })
                );
            }
            offlineArithmeticRecovery.push({
              scope:
                "Post-hoc numeric review only. Split oversized batches and truncate labels; numerical terms and divisors unchanged. Not a successful original tool call.",
              inputValidationIssues: validation.success ? [] : validation.error.issues,
              numericalChecks,
            });
          }
          continue;
        }
        if (!mcp) continue;
        const output = JSON.parse(tool.output as string);
        const actual = await mcp.callTool({
          name: tool.name,
          arguments: tool.arguments as Record<string, unknown>,
        });
        assert.deepEqual(actual, output, "Evidence mismatch: " + entry.id + ":" + tool.name);
        if (tool.name === "mcp_check_arithmetic") {
          const checked = checkArithmetic(tool.arguments);
          // Compare at the JSON tool boundary: JSON encodes JavaScript -0 as0.
          assert.deepEqual(JSON.parse(textContent(output)), JSON.parse(JSON.stringify(checked)));
          arithmetic.push(checked);
        }
      }
    } finally {
      await mcp?.close();
    }
    const semantic = ledger?.cases[entry.id]
      ? bindReferenceReview(record, ledger.cases[entry.id])
      : undefined;
    const answer = semantic?.adjudicatedAnswer ?? record.episode.answer;
    const director = entry.role === "Mission Director";
    (director ? decisionPlanSchema : specialistAdviceSchema).parse(answer);
    const submittedOutcome = director
      ? evaluateActionSet(state, (answer as { actions: MissionAction[] }).actions)
      : undefined;
    if (semantic?.adjudicatedAnswer !== undefined) {
      const episode = {
        ...record.episode,
        answer,
        tools: record.episode.tools.map((tool) =>
          tool.name === "submit_mission_plan" && tool.success
            ? { ...tool, arguments: answer }
            : tool
        ),
      };
      assert(
        gradeEpisode(JSON.stringify(episode), item).pass,
        "Adjudicated answer fails structural/outcome gate"
      );
    }
    checks.push({
      caseId: entry.id,
      role: entry.role,
      referenceSha256: row.sha256,
      outputSha256: sha256(JSON.stringify(record.episode.answer)),
      structural,
      rejectedToolCalls: record.episode.tools.filter((tool) => !tool.success).length,
      evidenceReplay: director
        ? "All Director tool results match frozen specialist fixtures and submission validation exactly"
        : "All successful specialist tools match current MCP evidence exactly",
      arithmetic,
      offlineArithmeticRecovery,
      facts: missionEvidence(state),
      oracle: {
        feasible: oracle.feasible,
        acceptableActionSets: oracle.acceptable,
        bestAchievableUnmet: oracle.bestAchievableUnmet,
      },
      submittedOutcome,
      witnessOutcome: evaluateActionSet(state, oracle.acceptable[0]),
      semanticReview: semantic ?? { status: "pending" },
      approvedForReference: Boolean(
        (semantic && semantic.verdict !== "needs_correction" && structural.pass) ||
        semantic?.adjudicatedAnswer !== undefined
      ),
    });
  }
  if (ledger) assert.equal(Object.keys(ledger.cases).length, 45);
  const report = {
    reviewedAt: new Date().toISOString(),
    datasetSha256: datasetHash,
    model: referenceModel,
    effort: referenceEffort,
    reviewer: ledger?.reviewer ?? "Semantic review pending",
    independentHumanReview: "not performed",
    comparison: "on_hold; no Promptfoo candidate or semantic-judge calls",
    cases: checks,
    reviewed: checks.filter((check) => check.semanticReview && "verdict" in check.semanticReview)
      .length,
    approvedForReference: checks.filter((check) => check.approvedForReference).length,
  };
  atomicJson(join(root, "review.json"), report);
  atomicJson(join(root, "reviewed-answers.json"), {
    datasetSha256: datasetHash,
    model: referenceModel,
    effort: referenceEffort,
    status:
      report.reviewed === 45
        ? "codex_reviewed_reference_answers; grader calibration and independent human approval pending"
        : "draft; semantic review pending",
    cases: checks.map((check) => {
      const row = manifest.rows.find((row: { caseId: string }) => row.caseId === check.caseId);
      const record: ReferenceRecord = JSON.parse(readFileSync(join(root, row.file), "utf8"));
      const semantic = ledger?.cases[check.caseId];
      return {
        caseId: check.caseId,
        answer: semantic?.adjudicatedAnswer ?? record.episode!.answer,
        source:
          semantic?.adjudicatedAnswer !== undefined
            ? "Codex adjudication of GPT-6.1/high draft"
            : "GPT-6.1/high draft reviewed by Codex",
        originalOutputSha256: check.outputSha256,
        approvedForReference: check.approvedForReference,
        ...(semantic?.adjudication ? { adjudication: semantic.adjudication } : {}),
      };
    }),
  });
  if (report.reviewed === 45)
    atomicJson(join(directory, "references/index.json"), {
      run: relative(directory, root),
      datasetSha256: datasetHash,
      cases: 45,
      model: referenceModel,
      effort: referenceEffort,
      status:
        report.approvedForReference === 45
          ? "references_reviewed_calibration_pending"
          : "references_reviewed_with_unresolved_cases",
      reviewed: report.reviewed,
      approvedForReference: report.approvedForReference,
      reviewSha256: sha256(readFileSync(join(root, "review.json"))),
      reviewedAnswersSha256: sha256(readFileSync(join(root, "reviewed-answers.json"))),
    });
  console.log(
    JSON.stringify({
      directory: root,
      reviewed: report.reviewed,
      approvedForReference: report.approvedForReference,
      structuralPasses: checks.filter((check) => check.structural.pass).length,
    })
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
