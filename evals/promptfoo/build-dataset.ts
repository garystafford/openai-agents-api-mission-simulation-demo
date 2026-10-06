import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";
import { scenarioIds } from "../../server/mission.js";
import { missionEvidence } from "../../server/mission-evidence.js";
import { actionCapabilities } from "../../server/simulation.js";
import { specialistAdviceSchema } from "../../server/agent-schemas.js";
import type { RecordedConsultation } from "../../server/agent-recording.js";
import type { MissionState } from "../../server/mission-contract.js";
import { specialistNames } from "../../server/mission-team.js";
import { gradeEpisode } from "./assertions.js";
import type { ReviewedCase, DatasetManifest } from "./dataset.js";

export { actionOracle, successfulActionSets } from "./oracle.js";
import { actionOracle } from "./oracle.js";
import { reviewedSource, type SourceReview } from "./review-binding.js";
import { prepareReplay } from "./replay.js";
import { missionRulesVersion } from "../../server/mission-rules.js";

export function requiredFindings(role: string, state: MissionState): string[] {
  const common = [
    "Use the published absolute responseWindow for final confirmation, incident-specific recallPrerequisites, and commander authority with at most four commands authorized together. Distinguish optional later forecasts from required confirmation.",
    "Keep structured output concise and free of stray or unrelated words.",
    "Use only evidence actually available to this consultation; state material missing readings as uncertainty.",
    "At elapsed time zero there is only one sample: do not claim a measured trend, successful repair, or a completed mission.",
    "Treat action durations, prerequisites and resource rates as synthetic simulator rules; commands start together and array order does not schedule them.",
    "Power endurance is an estimate from the battery and net draw at a stated observation time, not a required elapsed mission duration. Distinguish current objective compliance, confirmed response recovery, and a separate projection to hazard arrival.",
  ];
  const roles: Record<string, string[]> = {
    "Mission Director": [
      "Prioritize crew and life-critical capability. Meet all measured objectives when feasible; otherwise propose a justified best-effort response and disclose evidenced remaining shortfalls or uncertainty. Do not require knowledge of undocumented internal simulator equations.",
      "Consult relevant specialists, synthesize their evidence, submit the exact proposal, and require commander authorization before dispatch.",
      "Explain timing, resource and prerequisite trade-offs without claiming that actions have already occurred.",
    ],
    "Power & Thermal": [
      "Interpret observed electrical reserve, net draw, and power endurance; distinguish thermal evidence from unmeasured thermal assumptions.",
      "Assess load shedding and repair/backup-link power costs where relevant. Do not infer that nominal initial battery means the response remains feasible.",
    ],
    "Life Support": [
      "Distinguish measured air-processing capacity from oxygen concentration, carbon dioxide and cabin pressure. Do not invent gas measurements absent from this incident's telemetry.",
      "If air processing is below its objective, identify the faulty loop and the available isolation mitigation. For nominal observed life-support systems, report that scope without declaring unobserved systems safe.",
    ],
    "Weather & Navigation": [
      "Interpret the remaining hazard window, crew position/return estimate, rover mobility, and communications prerequisites where relevant.",
      "Distinguish a knowledge-improving orbital check from moving the hazard arrival time or physically changing the hazard.",
    ],
    "Risk Review": [
      "Identify at least one material incident-specific assumption, evidence gap or unsafe timing/resource trade-off, using source facts.",
      "Make uncertainty actionable without inventing a new available action or requesting endless repeat lookups. A simulated cross-check shares its source with telemetry and is not an independent physical sensor.",
    ],
  };
  const scenarios: Record<string, string> = {
    dust_storm:
      "The incident combines an outside crew member, faulty air processing, and a power-endurance objective. Account for these interacting risks within the 18-minute window.",
    coolant_leak:
      "The active coolant leak needs a feasible repair before reserve/temperature conditions become unsafe; repair consumes battery while nonessential load continues until shedding completes.",
    relay_failure:
      "Restoring communications adds ongoing backup-relay draw; assess the communications and power objectives together.",
    solar_flare:
      "Cumulative crew radiation dose cannot be erased; shelter attenuates exposure after crew return without reducing the external radiation flux.",
    rover_recovery:
      "Rover repair requires at least 80% communications and consumes power. Distinguish restored mobility from confirmed crew arrival at safety; explicitly include recall_eva for crew return and do not claim repair alone brings crew home. All stated prerequisites must fit the response window.",
  };
  return [...common, ...roles[role], "Within this role's scope: " + scenarios[state.scenario.id]];
}

// Source judgments stay historical; current grading must not inherit a resolved ambiguity.
export function currentReviewFindings(state: MissionState, findings: string[]) {
  return findings.map((finding) => {
    const relayAmbiguity =
      state.scenario.id === "relay_failure" &&
      /recall|rover|applicability/i.test(finding) &&
      /ambig|qualif|clarif|conditional/i.test(finding);
    const solarMode =
      state.scenario.id === "solar_flare" && /rover-return|rover-gated/i.test(finding);
    return relayAmbiguity || solarMode
      ? "Use the explicit current recallPrerequisites: ordinary recall in this incident does not require an 80% communications link. Do not import the stranded-rover gate or treat its applicability as missing evidence. Preserve current mobility and travel-time requirements."
      : finding;
  });
}

export function buildDataset(recordingDirectory: string, derive = false) {
  const collection = JSON.parse(readFileSync(join(recordingDirectory, "manifest.json"), "utf8"));
  const raw = collection as {
    complete: boolean;
    revision: string;
    workingTreeDirty: boolean;
    rows: Array<{
      missionId: string;
      scenario: string;
      variant: string;
      status: string;
      recordIds: string[];
      usageSnapshot: unknown;
    }>;
  };
  if (!raw.complete || raw.rows.length !== 10)
    throw new Error("Expected ten complete collection missions.");
  raw.rows.sort(
    (a, b) =>
      scenarioIds.indexOf(a.scenario as MissionState["scenario"]["id"]) * 2 +
      Number(a.variant !== "baseline") -
      (scenarioIds.indexOf(b.scenario as MissionState["scenario"]["id"]) * 2 +
        Number(b.variant !== "baseline"))
  );
  const root = resolve("evals/promptfoo");
  mkdirSync(join(root, "cases"), { recursive: true });
  // Retain collection outcomes/accounting without publishing a machine-local path.
  const collectionSummary = { ...collection };
  delete collectionSummary.directory;
  writeFileSync(join(root, "collection.json"), JSON.stringify(collectionSummary, null, 2) + "\n");
  const sourceReviews = JSON.parse(readFileSync(join(root, "source-reviews.json"), "utf8")) as {
    cases: Record<string, SourceReview>;
  };
  const manifest: DatasetManifest = {
    version: derive ? 4 : 3,
    sourceKind: derive ? "derived_replay" : "fresh_recordings",
    referenceStatus: "draft_awaiting_gpt_6_1_high_reference_generation_and_review",
    collectionRevision: raw.revision,
    rulesVersion: missionRulesVersion,
    sourceDatasetSha256: createHash("sha256")
      .update(
        readFileSync(join(root, derive ? "history/v3/dataset.json" : "history/v2/dataset.json"))
      )
      .digest("hex"),
    recordingDirectory: relative(root, recordingDirectory),
    cases: [],
  };
  const reviews: unknown[] = [];
  const roles = ["Mission Director", ...specialistNames];
  for (const [roleIndex, role] of roles.entries()) {
    // Each role omits a different second-variant mission. Both variants of
    // most incidents remain paired; every role still covers all five incidents.
    const omitted = roleIndex * 2 + 1;
    for (const [runIndex, row] of raw.rows.entries()) {
      const records = row.recordIds.map(
        (id) =>
          JSON.parse(
            readFileSync(join(recordingDirectory, id + ".json"), "utf8")
          ) as RecordedConsultation
      );
      const record = records.find((r) => r.role === role && !r.continuing && !r.error && r.output);
      if (!record)
        throw new Error("Missing fresh consultation for " + role + " in " + row.missionId);
      const fixedReports = Object.fromEntries(
        specialistNames.map((name) => {
          const source = records.find((r) => r.role === name && !r.continuing && !r.error);
          if (!source) throw new Error("Missing fixed specialist report: " + name);
          return [name, specialistAdviceSchema.parse(JSON.parse(source.output))];
        })
      );
      const id =
        role.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-") +
        "--" +
        row.scenario +
        "--" +
        row.variant;
      const sourceReview = reviewedSource(record, sourceReviews.cases[id]);
      const replay = derive ? prepareReplay(record) : undefined;
      const contextState = replay?.state ?? record.state;
      const projection = missionEvidence(contextState);
      const oracle = role === "Mission Director" ? actionOracle(contextState) : undefined;
      const acceptableActionSets = oracle?.acceptable ?? [];
      const item: ReviewedCase = {
        id,
        record,
        ...(replay ? { replay } : {}),
        fixedReports,
        review: {
          status: "agent_reviewed",
          sourceRecordId: sourceReview.recordId,
          sourceOutputSha256: sourceReview.outputSha256,
          sourceVerdict: sourceReview.verdict,
          sourceReview: sourceReview.note,
          sourceUsage: (row.usageSnapshot as { samples?: Array<[string, unknown]> })?.samples?.find(
            ([key]) => key === record.sessionId + ":" + record.turnId
          )?.[1],
          reviewer: "Codex; simulator/source review; not independently expert reviewed",
          provenance:
            (derive
              ? "Derived replay of archived v3 actual consultation: current instructions, explicit contracts and calculator; no new response collected. Source review describes the historical output. "
              : "") +
            "Actual hosted Agents API consultation; production instructions and MCP evidence. Original output is an observation, not the grading oracle. Fresh post-fix collection with exact actual instructions, input and tool evidence.",
          requiredFindings: [
            ...requiredFindings(role, contextState),
            ...(derive
              ? currentReviewFindings(contextState, sourceReview.requiredFindings ?? [])
              : (sourceReview.requiredFindings ?? [])),
          ],
          facts: [
            projection,
            {
              actionCapabilities: Object.fromEntries(
                contextState.scenario.availableActions.map((action) => [
                  action,
                  actionCapabilities[action],
                ])
              ),
            },
          ],
          acceptableActionSets,
          objectiveFeasibility: oracle
            ? oracle.feasible
              ? "feasible"
              : "infeasible_under_action_catalog"
            : undefined,
          bestAchievableUnmet: oracle?.bestAchievableUnmet,
          referenceAssessment:
            "See review.json for deterministic source-response checks and REVIEW.md for the semantic source review.",
          notes:
            "Accept equivalent factual wording and alternative feasible recommendations. Do not require every available metric. Confidence is not numerically calibrated. Missing data must remain uncertain. Grade against the evaluation request (derived replay when present), role scope, evidence actually consulted and these simulator facts. Fixed specialist replies are actual source observations and may contain errors; they do not override the supplied rules.",
        },
      };
      if (oracle && !oracle.feasible) {
        item.review.requiredFindings.push(
          "The offline oracle finds no permitted single-proposal action set that achieves all objectives. Do not promise complete success: identify the remaining evidenced binding risk or honestly qualify the uncertain full-recovery claim. Do not require the agent to derive undocumented internal equations. The offline mitigation gate compares all plans at the original hazard deadline and ranks irreversible crew harm, crew arrival, life-support/thermal capability, other capability, then power margins. A failed reserve target must still be disclosed."
        );
        item.review.facts.push({ actionOracle: oracle });
      }
      const sourceOutput = JSON.stringify({
        answer: JSON.parse(record.output),
        tools: record.tools.map(({ call, result }) => ({
          name: call.name,
          arguments:
            typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments,
          success: result === null || result.success,
          ...(result?.success ? { output: result.output } : {}),
        })),
      });
      reviews.push({
        id,
        role,
        selectedForDataset: runIndex !== omitted,
        source: record.source,
        sourceRecordId: record.id,
        sourceOutputSha256: sourceReview.outputSha256,
        sourceVerdict: sourceReview.verdict,
        elapsedMs: record.elapsedMs,
        rejectedToolCalls: record.tools.filter(({ result }) => result?.success === false).length,
        missionId: row.missionId,
        objectiveFeasibility: item.review.objectiveFeasibility,
        deterministicSourceCheck: gradeEpisode(sourceOutput, item),
        checkScope: derive
          ? "Historical output checked offline against derived current context; not a live v4 result."
          : "Actual v3 source episode.",
        reviewedFacts: projection.telemetry.length,
        acceptablePlans: acceptableActionSets.length,
      });
      // Validate all 50 sources, including the five deliberately omitted from
      // the balanced 45-case comparison suite.
      if (runIndex === omitted) continue;
      const serialized = JSON.stringify(item, null, 2) + "\n";
      const file = "cases/" + id + ".json";
      writeFileSync(join(root, file), serialized);
      manifest.cases.push({
        id,
        role,
        scenario: row.scenario,
        variant: row.variant,
        file,
        sourceRecordSha256: createHash("sha256")
          .update(readFileSync(join(recordingDirectory, record.id + ".json")))
          .digest("hex"),
        sha256: createHash("sha256").update(serialized).digest("hex"),
      });
    }
  }
  writeFileSync(join(root, "dataset.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(
    join(root, "review.json"),
    JSON.stringify(
      {
        reviewer: "Codex",
        type: "offline simulator and structural source checks; semantic review recorded separately",
        cases: reviews,
      },
      null,
      2
    ) + "\n"
  );
  console.log(JSON.stringify({ cases: manifest.cases.length, perAgent: 9, recordingDirectory }));
}
if (process.argv[1]?.endsWith("build-dataset.ts")) {
  if (!process.argv[2]) throw new Error("Pass the collection directory.");
  buildDataset(resolve(process.argv[2]), process.argv.includes("--derive"));
}
