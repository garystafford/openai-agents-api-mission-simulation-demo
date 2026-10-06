import { specialistAdviceSchema, decisionPlanSchema } from "../../server/agent-schemas.js";
import { loadCase, type ReviewedCase } from "./dataset.js";
import { replayContext } from "./replay.js";
import { consultationRoles, type ReplayResult } from "./provider.js";
import { z } from "zod";

const auditSchema = z.object({
  answer: z.unknown(),
  tools: z.array(
    z
      .object({
        name: z.string().min(1),
        arguments: z.unknown(),
        success: z.boolean(),
        output: z.unknown().optional(),
        error: z.string().nullable().optional(),
      })
      .refine((tool) => Object.hasOwn(tool, "arguments"), "Tool arguments field is required.")
  ),
});
// JSON object key order is not part of proposal identity; array order is retained.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => JSON.stringify(key) + ":" + canonicalJson(entry))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "undefined";
}

export function gradeEpisode(output: string, item: ReviewedCase) {
  const fail = (reason: string) => ({ pass: false, score: 0, reason });
  let value: ReplayResult;
  try {
    const parsed = auditSchema.safeParse(JSON.parse(output));
    if (!parsed.success) return fail("Provider answer/tool audit is malformed.");
    value = parsed.data as ReplayResult;
  } catch {
    return fail("Provider output is not JSON.");
  }
  if (!Array.isArray(value.tools)) return fail("Tool audit is missing.");
  if (item.record.role === "Mission Director") {
    const parsed = decisionPlanSchema.safeParse(value.answer);
    if (!parsed.success) return fail("Director proposal violates its schema.");
    if (new Set(parsed.data.actions).size !== parsed.data.actions.length)
      return fail("Duplicate actions.");
    if (
      !parsed.data.actions.every((action) =>
        replayContext(item).state.scenario.availableActions.includes(action)
      )
    )
      return fail("Unavailable action.");
    const submitted = value.tools.filter(
      (tool) => tool.name === "submit_mission_plan" && tool.success
    );
    if (
      submitted.length !== 1 ||
      canonicalJson(submitted[0].arguments) !== canonicalJson(value.answer)
    )
      return fail("Exactly one matching pending submission is required.");
    if (
      !value.tools.some(
        (tool) =>
          tool.success && (consultationRoles[tool.name] || tool.name === "consult_specialists")
      )
    )
      return fail("No fresh specialist consultation.");
    const canonical = (actions: string[]) => [...actions].sort().join(",");
    if (
      !item.review.acceptableActionSets.some(
        (actions) => canonical(actions) === canonical(parsed.data.actions)
      )
    )
      return fail("Plan did not meet the simulator-verified outcome/mitigation gate.");
  } else {
    if (!specialistAdviceSchema.safeParse(value.answer).success)
      return fail("Specialist advice violates its schema.");
    if (
      !value.tools.some(
        (tool) =>
          tool.success &&
          ["mcp_read_mission_telemetry", "mcp_query_mission_protocol"].includes(tool.name)
      )
    )
      return fail("Required evidence was not consulted.");
    if (value.tools.length > 4) return fail("Evidence lookup limit exceeded.");
    const calls = value.tools.map((tool) => tool.name + ":" + canonicalJson(tool.arguments));
    if (new Set(calls).size !== calls.length) return fail("Repeated evidence source.");
    if (value.tools.some((tool) => !tool.name.startsWith("mcp_")))
      return fail("Specialist requested a non-evidence tool.");
  }
  return {
    pass: true,
    score: 1,
    reason:
      "Schema, tool behavior, and applicable simulator outcome checks passed. Semantic correctness is graded separately.",
  };
}
export default function assertion(output: string, context: { vars: { caseId: string } }) {
  return gradeEpisode(output, loadCase(context.vars.caseId));
}
