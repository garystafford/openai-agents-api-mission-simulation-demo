import { z } from "zod";
import { specialistName, specialistNames } from "./mission-team.js";
import type { SessionCreateParams } from "openai/resources/beta/agents/sessions/sessions";
import type { AgentToolParam } from "openai/resources/beta/agents/agents";
import type { FunctionCall } from "./agents-api.js";
import { missionActions, type MissionState, type DecisionPlan } from "./mission-contract.js";

export const specialistAdviceSchema = z.object({
  status: z.enum(["nominal", "watch", "critical"]),
  confidence: z.number().min(0).max(1),
  recommendation: z.string().min(1),
  evidence: z.array(z.string()).min(1).max(4),
  tradeoff: z.string().min(1),
});
export const decisionPlanSchema = z.object({
  headline: z.string().min(1),
  actions: z.array(z.enum(missionActions)).min(1).max(4),
  rationale: z.string().min(1),
  uncertainties: z.array(z.string()).max(3),
  approvalScope: z.string().min(1),
});
export const questionSchema = z.object({ question: z.string().min(1).max(4000) });
export const batchConsultationSchema = z.object({
  consultations: z
    .array(questionSchema.extend({ specialist: z.enum(specialistNames) }))
    .min(2)
    .max(4)
    .refine(
      (entries) => new Set(entries.map((entry) => entry.specialist)).size === entries.length,
      "Include each specialist at most once per batch."
    ),
});
// Hosted sessions created before the rename can still emit their original tool schema.
const savedBatchSchema = z.object({
  consultations: z.array(questionSchema.extend({ specialist: z.string() })),
});
export function parseBatchConsultations(value: unknown) {
  const saved = savedBatchSchema.safeParse(value);
  return batchConsultationSchema.safeParse(
    saved.success
      ? {
          consultations: saved.data.consultations.map((entry) => ({
            ...entry,
            specialist: specialistName(entry.specialist),
          })),
        }
      : value
  );
}
export function validateMissionPlan(state: MissionState, value: unknown): DecisionPlan {
  const plan = decisionPlanSchema.parse(typeof value === "string" ? JSON.parse(value) : value);
  if (new Set(plan.actions).size !== plan.actions.length)
    throw new Error(
      "actions contains duplicate commands: " +
        plan.actions.filter((action, index) => plan.actions.indexOf(action) !== index).join(", ") +
        "."
    );
  if (!plan.actions.every((action) => state.scenario.availableActions.includes(action)))
    throw new Error(
      "actions contains unavailable commands: " +
        plan.actions
          .filter((action) => !state.scenario.availableActions.includes(action))
          .join(", ") +
        "."
    );
  return plan;
}

export function planValidationFeedback(error: unknown): string {
  if (error instanceof z.ZodError)
    return (
      "Correct these proposal fields: " +
      error.issues
        .map((issue) => (issue.path.join(".") || "proposal") + ": " + issue.message)
        .join("; ") +
      ". Resubmit using existing evidence; further consultations are unnecessary for a format correction."
    );
  if (error instanceof SyntaxError)
    return "Proposal must be valid JSON. Correct the syntax and resubmit.";
  return (
    (error instanceof Error ? error.message : "Invalid proposal.") +
    " Correct the proposal using existing evidence and the available action catalog."
  );
}

export function validateAuthorizedPlan(
  state: MissionState,
  submitted: DecisionPlan,
  output: unknown
) {
  const finalPlan = validateMissionPlan(state, output);
  if (JSON.stringify(finalPlan) !== JSON.stringify(submitted))
    throw new Error(
      "The Director changed the authorized proposal. No actions were dispatched; reassess the incident."
    );
  return structuredClone(submitted);
}

export function functionTool(name: string, description: string, schema: z.ZodType): AgentToolParam {
  return { type: "function", name, description, parameters: z.toJSONSchema(schema) };
}
export function parseArguments(call: FunctionCall) {
  return typeof call.arguments === "string" ? JSON.parse(call.arguments) : call.arguments;
}
export function structuredText(schema: z.ZodType): NonNullable<SessionCreateParams.Agent["text"]> {
  return { format: { type: "json_schema", schema: z.toJSONSchema(schema) } };
}
