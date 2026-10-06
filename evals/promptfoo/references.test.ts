import assert from "node:assert/strict";
import { test } from "node:test";
import { referenceRequest, assertReferenceLive, referenceModel } from "./references.js";
import { loadCase, loadManifest } from "./dataset.js";
import { replayContext } from "./replay.js";

test("reference requests withhold answers and grading oracle while preserving evaluation inputs", () => {
  for (const entry of loadManifest().cases) {
    const item = loadCase(entry.id);
    const original = structuredClone(item);
    const request = referenceRequest(item);
    assert.equal(request.agent.model, referenceModel);
    assert.equal(request.agent.reasoning?.effort, "high");
    assert.equal(request.input, replayContext(item).input);
    assert.deepEqual(request.agent.tools, replayContext(item).agent.tools);
    assert.deepEqual(Object.keys(request).sort(), ["agent", "fixedReports", "input"]);
    assert.ok(!JSON.stringify(request).includes(item.record.output));
    assert.equal(request.fixedReports !== undefined, entry.role === "Mission Director");
    assert.deepEqual(item, original);
  }
});
test("reference activation is explicit and separate from comparison activation", () => {
  assert.throws(() => assertReferenceLive([]), /requires --live/);
  assert.throws(() => assertReferenceLive(["MARS_PROMPTFOO_LIVE=1"]), /requires --live/);
  assert.doesNotThrow(() => assertReferenceLive(["--live"]));
});

test("reference requests are unchanged when withheld source answers or oracle labels change", () => {
  const item = loadCase(loadManifest().cases[0].id);
  const request = referenceRequest(item);
  const changed = structuredClone(item);
  changed.record.output = "WITHHELD_ANSWER_CANARY";
  changed.review.facts = ["WITHHELD_ORACLE_CANARY"];
  changed.review.acceptableActionSets = [];
  changed.review.requiredFindings = ["WITHHELD_RUBRIC_CANARY"];
  assert.deepEqual(referenceRequest(changed), request);
});

test("reference semantic review is bound to the actual generated output", async () => {
  const { bindReferenceReview } = await import("./review-references.js");
  const { sha256 } = await import("./references.js");
  const answer = { recommendation: "Actual draft" };
  const record = {
    caseId: "fixture",
    episode: { answer, tools: [] },
  };
  const review = {
    outputSha256: sha256(JSON.stringify(answer)),
    verdict: "accepted" as const,
    note: "Checked evidence.",
    findings: [],
  };
  assert.equal(bindReferenceReview(record, review), review);
  assert.throws(
    () =>
      bindReferenceReview(
        { ...record, episode: { answer: { recommendation: "Changed" }, tools: [] } },
        review
      ),
    /exact generated answer/
  );
  assert.throws(
    () => bindReferenceReview(record, { ...review, adjudicatedAnswer: answer }),
    /explain its evidence/
  );
});

test("published references bind all45 examples to the frozen dataset and held rubric", async () => {
  const { loadReferenceBundle } = await import("./reference-artifacts.js");
  const bundle = loadReferenceBundle();
  assert.ok(bundle, "Publish the reviewed reference index before validating this suite");
  assert.equal(bundle.index.model, referenceModel);
  assert.equal(bundle.index.effort, "high");
  assert.equal(bundle.index.reviewed, 45);
  assert.equal(bundle.answers.size, 45);
  const { default: config } = await import("./promptfooconfig.js");
  assert.equal(config.tests.length, 45);
  for (const item of config.tests) {
    const reference = bundle.answers.get(item.vars.caseId);
    assert.ok(reference);
    assert.ok(item.vars.rubric.includes(JSON.stringify(reference.answer)));
    assert.match(item.vars.rubric, /nonexclusive/);
    assert.match(item.vars.rubric, /alternative feasible action sets/);
  }
});
