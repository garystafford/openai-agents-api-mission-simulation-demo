import { loadValidationCases } from "./validation-cases.js";
import { judgeProvider, gradingVersion } from "./grading-policy.js";

const saved = loadValidationCases();
export default {
  description:
    "Fresh selected-team validation: saved live reports, actual questions, no historical teacher answers",
  prompts: ["{{savedKey}}"],
  providers: [
    { id: "file://./validation-saved-provider.ts", label: "Saved fresh validation report" },
  ],
  evaluateOptions: { repeat: 1, maxConcurrency: 2, cache: false },
  defaultTest: {
    assert: [
      { type: "javascript", value: "file://./validation-assertion.ts" },
      {
        type: "llm-rubric",
        value: "{{rubric}}",
        threshold: 1,
        provider: { ...judgeProvider, config: { ...judgeProvider.config, maxRetries: 0 } },
      },
    ],
  },
  tests: saved.cases.map((item) => ({
    description: item.key,
    vars: { savedKey: item.key, rubric: item.rubric },
    metadata: {
      gradingVersion,
      role: item.role,
      scenario: item.scenario,
      outputSha256: item.outputSha256,
    },
  })),
};
