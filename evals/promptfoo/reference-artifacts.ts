import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { directory, loadManifest } from "./dataset.js";

export function loadReferenceBundle() {
  const indexPath = join(directory, "references/index.json");
  if (!existsSync(indexPath)) return undefined;
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.equal(
    index.datasetSha256,
    hash(readFileSync(join(directory, "dataset.json"))),
    "Reference bundle is stale for this dataset"
  );
  const root = resolve(directory, index.run);
  assert(
    root.startsWith(join(directory, "references") + "/"),
    "Reference archive must remain under references/"
  );
  const review = readFileSync(join(root, "review.json"));
  const answers = readFileSync(join(root, "reviewed-answers.json"));
  assert.equal(hash(review), index.reviewSha256, "Reference review changed after publication");
  assert.equal(
    hash(answers),
    index.reviewedAnswersSha256,
    "Reviewed reference answers changed after publication"
  );
  const bundle = JSON.parse(answers.toString()) as {
    cases: Array<{
      caseId: string;
      answer: unknown;
      approvedForReference: boolean;
      source: string;
    }>;
  };
  const manifest = loadManifest();
  assert.equal(bundle.cases.length, manifest.cases.length);
  assert.equal(new Set(bundle.cases.map((item) => item.caseId)).size, manifest.cases.length);
  assert(bundle.cases.every((item) => manifest.cases.some((entry) => entry.id === item.caseId)));
  return {
    index,
    answers: new Map(
      bundle.cases.filter((item) => item.approvedForReference).map((item) => [item.caseId, item])
    ),
  };
}
