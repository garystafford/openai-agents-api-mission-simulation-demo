import { z } from "zod";

const bounded = z.number().finite().min(-1_000_000).max(1_000_000);
export const arithmeticSchema = z.object({
  calculations: z
    .array(
      z.object({
        label: z.string().min(1).max(100),
        terms: z.array(z.array(bounded).min(1).max(8)).min(1).max(32),
        divisor: bounded
          .refine(
            (value) => Math.abs(value) >= 0.000001,
            "Divisor must be nonzero and at least 0.000001 in magnitude"
          )
          .default(1),
      })
    )
    .min(1)
    .max(8),
});
export const arithmeticDescription =
  "Check numerical arithmetic: submit 1–8 calculations per call, each with a label of 1–100 characters and 1–32 terms of 1–8 signed factors. For each calculation, sum the products of the factors, then divide by divisor (default 1). Example 48 - 4*0.4 - 27*0.55: terms [[48],[-4,0.4],[-27,0.55]]. Checks numbers only; does not validate assumed rates, time intervals, prerequisites or physical outcomes. Does not observe or change the mission.";

// Shared by production and evaluation replay; never include submitted values in errors.
export function evidenceFailureFeedback(
  callsUsed: number,
  detail = "Mission evidence lookup failed."
) {
  return (
    detail +
    (callsUsed < 4
      ? " Correct the arguments only if needed, within the remaining " +
        (4 - callsUsed) +
        " tool calls. Failed calculations remain unverified."
      : " No tool calls remain. Return a report with unresolved uncertainty; failed calculations remain unverified.")
  );
}

export function arithmeticValidationFeedback(name: string, input: unknown, callsUsed: number) {
  if (name !== "mcp_check_arithmetic") return undefined;
  const parsed = arithmeticSchema.safeParse(input);
  if (parsed.success) return undefined;
  const issues = parsed.error.issues
    .slice(0, 4)
    .map((issue) => issue.path.join(".") + ": " + issue.message)
    .join("; ");
  return evidenceFailureFeedback(callsUsed, "Invalid arithmetic arguments: " + issues + ".");
}
export const arithmeticAgentTool = {
  type: "function" as const,
  name: "mcp_check_arithmetic",
  description: arithmeticDescription,
  parameters: z.toJSONSchema(arithmeticSchema),
};
export function checkArithmetic(input: unknown) {
  const parsed = arithmeticSchema.parse(input);
  return {
    scope:
      "Numerical arithmetic only; assumptions and simulator outcomes require separate evidence.",
    calculations: parsed.calculations.map(({ label, terms, divisor }) => {
      const termValues = terms.map((factors) => factors.reduce((a, b) => a * b, 1));
      const numerator = termValues.reduce((a, b) => a + b, 0);
      return {
        label,
        termValues,
        numerator,
        divisor,
        result: Number((numerator / divisor).toPrecision(12)),
      };
    }),
  };
}
