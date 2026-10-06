import { focusedJudgeCases } from "./focused-saved-provider.js";
import { judgeProvider } from "./grading-policy.js";
export default {
  description: "Focused model comparison: fresh judge calls on saved candidate answers",
  prompts: ["{{savedKey}}"],
  providers: [{ id: "file://./focused-saved-provider.ts", label: "Saved focused answer" }],
  evaluateOptions: { repeat: 1, maxConcurrency: 4, cache: false },
  defaultTest: {
    assert: [
      { type: "javascript", value: "file://./focused-assertion.ts" },
      {
        type: "llm-rubric",
        value: "{{rubric}}",
        threshold: 1,
        provider: { ...judgeProvider, config: { ...judgeProvider.config, maxRetries: 0 } },
      },
    ],
  },
  tests: focusedJudgeCases().map((row) => ({
    description: row.key,
    vars: { savedKey: row.key, caseId: row.caseId, rubric: row.rubric },
    metadata: { role: row.role, model: row.model, effort: row.effort },
  })),
};
