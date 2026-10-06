import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import regrade from "./regrade-config.js";
import { directory } from "./dataset.js";
import { gradingVersion, judgeProvider } from "./grading-policy.js";

const anchors = JSON.parse(readFileSync(resolve(directory, "calibration/anchors.json"), "utf8"));
assert.equal(anchors.version, gradingVersion);
assert.equal(anchors.status, "finalized_offline");
const keys = new Set<string>(anchors.anchors.map((anchor: { key: string }) => anchor.key));
assert.equal(keys.size, 27);
const tests = regrade.tests.filter((test) => keys.has(test.vars.savedKey));
assert.equal(tests.length, 27);

export default {
  ...regrade,
  description:
    gradingVersion + " judge-only calibration: 27 reviewed saved outputs, one judgment each",
  defaultTest: {
    assert: [
      regrade.defaultTest.assert[0],
      {
        ...regrade.defaultTest.assert[1],
        provider: { ...judgeProvider, config: { ...judgeProvider.config, maxRetries: 0 } },
      },
    ],
  },
  tests,
};
