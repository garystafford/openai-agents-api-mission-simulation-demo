import type {
  ApiProvider,
  CallApiContextParams,
  CallApiOptionsParams,
  ProviderResponse,
} from "promptfoo";
import { z } from "zod";
import { assertComparisonReleased } from "./execution-policy.js";
import { gradingVersion } from "./grading-policy.js";
import { claimJudgeCall } from "./judge-scope.js";

const judgment = z
  .object({
    reason: z.string().min(1),
    pass: z.boolean(),
    score: z.union([z.literal(0), z.literal(1)]),
  })
  .superRefine((value, context) => {
    const verdict = value.reason.match(/^(PASS|FAIL|NEEDS_REVIEW)\b/)?.[1];
    if (!verdict || value.pass !== (verdict === "PASS") || value.score !== (value.pass ? 1 : 0))
      context.addIssue({
        code: "custom",
        message: "Binary score, pass flag and verdict prefix must agree.",
      });
  });

export function validateJudgeResponse(response: ProviderResponse): ProviderResponse {
  if (response.error) return response;
  try {
    const result = judgment.safeParse(
      typeof response.output === "string" ? JSON.parse(response.output) : response.output
    );
    if (!result.success) throw new Error("Nonbinary or inconsistent semantic judgment");
    return {
      ...response,
      output: JSON.stringify(result.data),
      metadata: {
        ...response.metadata,
        semanticVerdict: result.data.reason.match(/^(PASS|FAIL|NEEDS_REVIEW)\b/)![1],
      },
    };
  } catch {
    return {
      ...response,
      output: undefined,
      error:
        "Judge contract violation: expected JSON with PASS/FAIL/NEEDS_REVIEW, matching pass flag and binary 0/1 score. Requires review, not a candidate failure.",
      metadata: { ...response.metadata, semanticVerdict: "JUDGE_ERROR" },
    };
  }
}

// Guard the grader itself, including direct Promptfoo CLI use with saved answers.
export default class HeldJudgeProvider {
  private native?: ApiProvider;
  constructor(private readonly options: { config?: Record<string, unknown> } = {}) {}
  id() {
    return "held:gpt-6-sol:medium:" + gradingVersion;
  }
  private async provider() {
    if (!this.native) {
      const { loadApiProvider } = await import("promptfoo");
      this.native = await loadApiProvider("openai:responses:gpt-6-sol", {
        options: { config: this.options.config },
      });
    }
    return this.native;
  }
  async getOpenAiBody(prompt: string) {
    // Request rendering only; used by the existing offline shape check.
    const native = (await this.provider()) as ApiProvider & {
      getOpenAiBody(prompt: string): Promise<unknown>;
    };
    return native.getOpenAiBody(prompt);
  }
  async callApi(prompt: string, context?: CallApiContextParams, options?: CallApiOptionsParams) {
    const policy = assertComparisonReleased("judge");
    if (process.env.MARS_PROMPTFOO_LIVE !== "1")
      throw new Error(
        "Paid semantic grading requires separate authorization and explicit live activation."
      );
    const capture = claimJudgeCall(policy, prompt, context?.vars, this.options.config);
    try {
      const response = await (await this.provider()).callApi(prompt, context, options);
      const validated = validateJudgeResponse(response);
      capture?.({ response, semanticVerdict: validated.metadata?.semanticVerdict });
      return validated;
    } catch (error) {
      capture?.({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}
