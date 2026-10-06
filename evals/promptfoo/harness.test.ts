import assert from "node:assert/strict";
import { test } from "node:test";
import { createMission } from "../../server/mission.js";
import { benchmarkCases } from "../benchmark-cases.js";
import { successfulActionSets, actionOracle, currentReviewFindings } from "./build-dataset.js";
import { gradeEpisode } from "./assertions.js";
import MissionAgentProvider, { directorToolHandler } from "./provider.js";
import type { ReviewedCase } from "./dataset.js";
import type { FunctionCall } from "../../server/agents-api.js";

const state = createMission();
const plan = {
  headline: "Protect crew, air and power",
  actions: ["recall_eva", "shed_nonessential_load", "isolate_scrubber"],
  rationale: "Start concurrently with commander authorization",
  uncertainties: ["Only baseline telemetry"],
  approvalScope: "Simulated commands only",
};
const advice = {
  status: "critical",
  confidence: 0.8,
  recommendation: "Protect the crew",
  evidence: ["One crew outside"],
  tradeoff: "Research loads are shed",
};
const item: ReviewedCase = {
  id: "offline-fixture",
  record: {
    id: "record-fixture",
    role: "Mission Director",
    source: "director_selected",
    state,
    agent: { model: "gpt-6-sol" },
    input: "Assess the incident",
    continuing: false,
    startedAt: "2026-10-04T00:00:00Z",
    elapsedMs: 1,
    tools: [],
    output: JSON.stringify(plan),
  },
  fixedReports: { "Life Support": advice },
  review: {
    status: "agent_reviewed",
    reviewer: "offline fixture",
    provenance: "offline fixture",
    requiredFindings: [],
    facts: [],
    acceptableActionSets: successfulActionSets(state),
    referenceAssessment: "fixture",
    notes: "fixture",
  },
};
const submitted = { name: "submit_mission_plan", arguments: plan, success: true };
const consulted = {
  name: "consult_life_support",
  arguments: { question: "Assess cabin" },
  success: true,
};

test("Director grading accepts alternative successful plans and rejects draft-only or ineffective plans", () => {
  assert.equal(
    gradeEpisode(JSON.stringify({ answer: plan, tools: [consulted, submitted] }), item).pass,
    true
  );
  const alternate = { ...plan, actions: [...plan.actions, "verify_orbital_weather"] };
  assert.equal(
    gradeEpisode(
      JSON.stringify({
        answer: alternate,
        tools: [consulted, { ...submitted, arguments: alternate }],
      }),
      item
    ).pass,
    true
  );
  assert.equal(
    gradeEpisode(JSON.stringify({ answer: plan, tools: [consulted] }), item).pass,
    false
  );
  const ineffective = { ...plan, actions: ["recall_eva"] };
  assert.equal(
    gradeEpisode(
      JSON.stringify({
        answer: ineffective,
        tools: [consulted, { ...submitted, arguments: ineffective }],
      }),
      item
    ).pass,
    false
  );
});
test("specialist grading requires an actual successful evidence read and rejects repeated lookup", () => {
  const specialist = { ...item, record: { ...item.record, role: "Life Support" as const } };
  const evidence = {
    name: "mcp_read_mission_telemetry",
    arguments: { system: "all" },
    success: true,
  };
  assert.equal(
    gradeEpisode(JSON.stringify({ answer: advice, tools: [evidence] }), specialist).pass,
    true
  );
  assert.equal(gradeEpisode(JSON.stringify({ answer: advice, tools: [] }), specialist).pass, false);
  assert.equal(
    gradeEpisode(JSON.stringify({ answer: advice, tools: [evidence, evidence] }), specialist).pass,
    false
  );
  assert.equal(
    gradeEpisode(
      JSON.stringify({ answer: advice, tools: [{ ...evidence, success: false }] }),
      specialist
    ).pass,
    false
  );
});
test("Director replay waits for authorization and returns frozen reports without spawning specialists", async () => {
  const handle = directorToolHandler(item);
  const call = (name: string, args: unknown): FunctionCall => ({
    type: "function_call",
    name,
    arguments: args as FunctionCall["arguments"],
    call_id: "fixture",
    turn_id: "fixture",
  });
  assert.equal((await handle(call("submit_mission_plan", plan)))?.success, false);
  const reply = await handle(call("consult_life_support", { question: "A different question" }));
  assert.equal(reply?.success, true);
  assert.deepEqual(JSON.parse(reply!.output as string), advice);
  assert.equal(await handle(call("submit_mission_plan", plan)), null);
});
test("infeasible reduced-reserve incident has a labeled mitigation oracle rather than a false perfect answer", () => {
  const reduced = benchmarkCases(1, ["reduced_reserve"], "promptfoo-v1").find(
    (entry) => entry.state.scenario.id === "coolant_leak"
  )!;
  const oracle = actionOracle(reduced.state);
  assert.equal(oracle.feasible, false);
  assert.ok(oracle.minimumUnmet > 0);
  assert.ok(oracle.acceptable.length > 0);
});
test("provider refuses paid execution before any case loading or API creation", async () => {
  const previous = process.env.MARS_PROMPTFOO_LIVE;
  process.env.MARS_PROMPTFOO_LIVE = "1";
  try {
    await assert.rejects(
      new MissionAgentProvider().callApi("does-not-exist"),
      /Paid Promptfoo comparison is disabled/
    );
  } finally {
    if (previous === undefined) delete process.env.MARS_PROMPTFOO_LIVE;
    else process.env.MARS_PROMPTFOO_LIVE = previous;
  }
});

test("refresh rejects stale semantic reviews even when the case name is unchanged", async () => {
  const { reviewedSource, outputHash } = await import("./review-binding.js");
  const review = {
    recordId: item.record.id,
    outputSha256: outputHash(item.record),
    verdict: "accepted" as const,
    note: "Reviewed actual evidence.",
  };
  assert.equal(reviewedSource(item.record, review), review);
  assert.throws(
    () => reviewedSource({ ...item.record, id: "fresh-record" }, review),
    /exact fresh consultation/
  );
  assert.throws(
    () => reviewedSource({ ...item.record, output: "different response" }, review),
    /exact fresh consultation/
  );
});

test("derived grading resolves corrected prerequisite ambiguity without rewriting source review", () => {
  const source = [
    "Public rover-rescue wording is ambiguous; qualify recall applicability.",
    "Check arithmetic.",
  ];
  const current = currentReviewFindings(createMission("relay_failure"), source);
  assert.match(current[0], /does not require an 80% communications link/);
  assert.equal(current[1], source[1]);
  assert.match(source[0], /ambiguous/);
  assert.deepEqual(currentReviewFindings(createMission("rover_recovery"), source), source);
});
