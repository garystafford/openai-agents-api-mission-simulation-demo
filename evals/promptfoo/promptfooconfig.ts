import { loadCase, loadManifest } from "./dataset.js";

import { loadReferenceBundle } from "./reference-artifacts.js";
import { buildRubric, gradingVersion, judgeProvider } from "./grading-policy.js";
const references = loadReferenceBundle();

const config = {
  description: "Mars Mission Control: 9 recorded cases per agent, GPT-6 Luna low/medium/high",
  prompts: ["{{caseId}}"],
  providers: ["low", "medium", "high"].map((effort) => ({
    id: "file://./provider.ts",
    label: "gpt-6-luna / " + effort,
    config: { model: "gpt-6-luna", effort },
  })),
  evaluateOptions: { repeat: 1, maxConcurrency: 2, cache: false },
  defaultTest: {
    assert: [
      { type: "javascript", value: "file://./assertions.ts" },
      {
        type: "llm-rubric",
        value: "{{rubric}}",
        threshold: 1,
        provider: judgeProvider,
      },
    ],
  },
  tests: loadManifest().cases.map((entry) => {
    const item = loadCase(entry.id);
    return {
      description: entry.id,
      vars: {
        caseId: entry.id,
        rubric: buildRubric(item, references?.answers.get(entry.id)?.answer),
      },
      metadata: {
        gradingVersion,
        role: entry.role,
        scenario: entry.scenario,
        variant: entry.variant,
        source: item.record.source,
        missionGroup: item.record.state.missionId,
      },
    };
  }),
};
export default config;
