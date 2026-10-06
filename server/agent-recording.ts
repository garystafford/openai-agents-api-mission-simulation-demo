import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { SessionCreateParams } from "openai/resources/beta/agents/sessions/sessions";
import type { AgentProfileName } from "./agent-profiles.js";
import type { FunctionCall, SessionRef, ToolResult } from "./agents-api.js";
import type { MissionState } from "./mission-contract.js";

export type RecordedConsultation = {
  id: string;
  role: AgentProfileName;
  source: "director_selected" | "coverage_supplement";
  state: MissionState;
  agent: SessionCreateParams.Agent;
  input: string;
  continuing: boolean;
  startedAt: string;
  elapsedMs: number;
  sessionId?: string;
  turnId?: string;
  tools: Array<{ call: FunctionCall; result: ToolResult | null }>;
  output: string;
  error?: string;
};
type Handler = (call: FunctionCall) => Promise<ToolResult | null>;
type Result = { text: string; pending?: FunctionCall };
const recording = new AsyncLocalStorage<{
  state: MissionState;
  source: RecordedConsultation["source"];
  save: (record: RecordedConsultation) => void;
}>();

// Opt-in evaluation capture. Normal application sessions never record content.
// Only application-visible inputs, function results and final output are saved.
export function withAgentRecording<T>(
  state: MissionState,
  source: RecordedConsultation["source"],
  save: (record: RecordedConsultation) => void,
  operation: () => Promise<T>
) {
  return recording.run({ state: structuredClone(state), source, save }, operation);
}

export async function recordAgentRun(
  role: AgentProfileName,
  ref: SessionRef,
  agent: SessionCreateParams.Agent,
  input: string,
  handler: Handler,
  operation: (handler: Handler) => Promise<Result>
): Promise<Result> {
  const context = recording.getStore();
  if (!context) return operation(handler);
  const started = Date.now();
  const record: RecordedConsultation = {
    id: randomUUID(),
    role,
    source: context.source,
    state: context.state,
    agent: structuredClone(agent),
    input,
    continuing: Boolean(ref.id),
    startedAt: new Date(started).toISOString(),
    elapsedMs: 0,
    tools: [],
    output: "",
  };
  try {
    const result = await operation(async (call) => {
      const item = { call: structuredClone(call), result: null as ToolResult | null };
      record.tools.push(item);
      item.result = structuredClone(await handler(call));
      return item.result;
    });
    record.output = result.pending ? JSON.stringify(result.pending.arguments) : result.text;
    // Arguments may already be encoded JSON.
    if (result.pending && typeof result.pending.arguments === "string")
      record.output = result.pending.arguments;
    return result;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    record.sessionId = ref.id;
    record.turnId = ref.turnId;
    record.elapsedMs = Date.now() - started;
    context.save(record);
  }
}
