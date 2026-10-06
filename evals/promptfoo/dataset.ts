import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RecordedConsultation } from "../../server/agent-recording.js";
import type { MissionAction } from "../../server/mission-contract.js";

export type ReviewedCase = {
  id: string;
  record: RecordedConsultation;
  replay?: {
    rulesVersion: number;
    provenance: string;
    state: RecordedConsultation["state"];
    agent: RecordedConsultation["agent"];
    input: string;
  };
  fixedReports: Record<string, unknown>;
  review: {
    status: "agent_reviewed";
    sourceRecordId?: string;
    sourceOutputSha256?: string;
    sourceVerdict?: string;
    sourceReview?: string;
    sourceUsage?: unknown;
    reviewer: string;
    provenance: string;
    requiredFindings: string[];
    facts: unknown[];
    acceptableActionSets: MissionAction[][];
    objectiveFeasibility?: "feasible" | "infeasible_under_action_catalog";
    bestAchievableUnmet?: number;
    referenceAssessment: string;
    notes: string;
  };
};
export type DatasetManifest = {
  version: number;
  rulesVersion?: number;
  sourceDatasetSha256?: string;
  collectionRevision?: string;
  sourceKind?: "fresh_recordings" | "derived_replay";
  referenceStatus?: "draft_awaiting_gpt_6_1_high_reference_generation_and_review";
  recordingDirectory: string;
  cases: Array<{
    id: string;
    role: string;
    scenario: string;
    variant: string;
    file: string;
    sha256: string;
    sourceRecordSha256?: string;
  }>;
};
export const directory = fileURLToPath(new URL("./", import.meta.url));
export function loadManifest(): DatasetManifest {
  return JSON.parse(readFileSync(new URL("./dataset.json", import.meta.url), "utf8"));
}
export function loadCase(id: string): ReviewedCase {
  const entry = loadManifest().cases.find((item) => item.id === id);
  if (!entry) throw new Error("Unknown evaluation case: " + id);
  return JSON.parse(readFileSync(new URL(entry.file, import.meta.url), "utf8"));
}
