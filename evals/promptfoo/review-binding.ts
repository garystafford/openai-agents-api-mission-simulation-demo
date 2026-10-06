import { createHash } from "node:crypto";
import type { RecordedConsultation } from "../../server/agent-recording.js";
export type SourceReview = {
  recordId: string;
  outputSha256: string;
  verdict: "accepted" | "accepted_with_caveats" | "needs_correction";
  note: string;
  requiredFindings?: string[];
};
export function outputHash(record: RecordedConsultation) {
  return createHash("sha256").update(record.output).digest("hex");
}
export function reviewedSource(record: RecordedConsultation, review?: SourceReview) {
  if (!review || review.recordId !== record.id || review.outputSha256 !== outputHash(record))
    throw new Error(
      "A review bound to this exact fresh consultation/output is required: " + record.id
    );
  if (
    !review.note.trim() ||
    !["accepted", "accepted_with_caveats", "needs_correction"].includes(review.verdict)
  )
    throw new Error("A substantive semantic review and valid verdict are required.");
  return review;
}
