import OpenAI from "openai";
import {
  abortable,
  cancellationConfirmationMilliseconds,
  type InvestigationBudget,
} from "./investigation-budget.js";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionInputParam,
} from "openai/resources/beta/agents/agents";
import type { SessionCreateParams } from "openai/resources/beta/agents/sessions/sessions";
import type { Stream } from "openai/core/streaming";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { MissionUsageCollector, pricingPerMillion } from "./mission-usage.js";

export type FunctionCall = AgentSession.SessionRequiredActionResourceFunctionCall;
export type ToolResult = AgentSessionInputParam.SessionInputParamAgentSessionInputToolResult;
export type SessionRef = {
  id?: string;
  turnId?: string;
  previousTurnId?: string;
  model: string;
  role?: string;
  missionId?: string;
  results: Map<string, ToolResult>;
};
type ToolHandler = (call: FunctionCall) => Promise<ToolResult | null>;

// Only produced after the session is inactive and its known turn is terminal.
export class ConsultationTimeoutError extends Error {
  constructor(role: string) {
    super(
      role +
        " consultation deadline reached; assessment unavailable. Remote stop confirmed; no automatic retry."
    );
    this.name = "ConsultationTimeoutError";
  }
}

export function toolResult(call: FunctionCall, output: unknown): ToolResult {
  return {
    type: "agent.session.input.tool_result",
    turn_id: call.turn_id,
    call_id: call.call_id,
    success: true,
    output: JSON.stringify(output),
  };
}
export function toolError(call: FunctionCall, message: string): ToolResult {
  return {
    type: "agent.session.input.tool_result",
    turn_id: call.turn_id,
    call_id: call.call_id,
    success: false,
    error: message,
  };
}

// The API owns the loop. This adapter responds to application functions and
// observes a specific turn. Closing an observer does not cancel remote work.
export class AgentsApi {
  budget?: InvestigationBudget;
  private readonly consultationSignal = new AsyncLocalStorage<AbortSignal>();
  private signal() {
    const signals = [this.budget?.controller.signal, this.consultationSignal.getStore()].filter(
      (signal): signal is AbortSignal => Boolean(signal)
    );
    return signals.length ? AbortSignal.any(signals) : undefined;
  }
  private options() {
    this.budget?.check();
    const signal = this.signal();
    signal?.throwIfAborted();
    return { signal };
  }
  async withConsultationDeadline<T>(
    ref: SessionRef,
    milliseconds: number,
    operation: () => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error(
            (ref.role ?? "Specialist") +
              " consultation deadline reached; assessment incomplete. No automatic paid retry."
          )
        ),
      milliseconds
    );
    try {
      return await this.consultationSignal.run(controller.signal, () =>
        abortable(operation(), this.signal())
      );
    } catch (error) {
      if (controller.signal.aborted) {
        // Aborting a stream alone does not stop hosted model work.
        try {
          if (!ref.id)
            throw new Error("Session ID unavailable; remote stop cannot be confirmed.", {
              cause: error,
            });
          await this.cancel(ref);
        } catch (cleanupError) {
          throw new Error("Consultation timed out and cancellation could not be confirmed.", {
            cause: cleanupError,
          });
        }
        this.budget?.check();
        throw new ConsultationTimeoutError(ref.role ?? "Specialist");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  constructor(
    readonly client: OpenAI,
    private readonly usage: MissionUsageCollector,
    private readonly checkpoint: () => void = () => {}
  ) {}

  async start(
    ref: SessionRef,
    agent: SessionCreateParams.Agent,
    input: string,
    handleTool: ToolHandler
  ) {
    if (this.budget && !pricingPerMillion[ref.model])
      throw new Error("Configure pricing for the selected model before starting an investigation.");
    const events = await this.client.beta.agents.sessions.create(
      {
        agent,
        // The simulator uses application tools, with no shell or file operations.
        environment: { type: "none" },
        metadata: {
          app: "mars-mission-control",
          ...(ref.role ? { role: ref.role } : {}),
          ...(ref.missionId ? { mission_id: ref.missionId } : {}),
        },
        input,
        stream: true,
      },
      this.options()
    );
    return this.consume(ref, events, handleTool);
  }

  async send(ref: SessionRef, input: string, handleTool: ToolHandler) {
    const events = await this.client.beta.agents.sessions.events.stream(ref.id!, this.options());
    ref.previousTurnId = ref.turnId;
    ref.turnId = undefined;
    this.checkpoint();
    try {
      await this.client.beta.agents.sessions.events.create(
        ref.id!,
        {
          "Idempotency-Key": randomUUID(),
          events: [
            {
              type: "agent.session.input.message",
              input: [{ role: "user", content: [{ type: "input_text", text: input }] }],
            },
          ],
        },
        this.options()
      );
      return await this.consume(ref, events, handleTool);
    } finally {
      events.controller.abort();
    }
  }

  async resume(ref: SessionRef, result: ToolResult, handleTool: ToolHandler) {
    const events = await this.client.beta.agents.sessions.events.stream(ref.id!, this.options());
    try {
      // Save the exact result before submission; never change a commander's
      // decision or re-execute a function when recovering an observer.
      ref.results.set(result.call_id, result);
      this.checkpoint();
      await this.client.beta.agents.sessions.events.create(
        ref.id!,
        { events: [result] },
        this.options()
      );
      return await this.consume(ref, events, handleTool);
    } finally {
      events.controller.abort();
    }
  }

  private async requiredActions(ref: SessionRef, session: AgentSession, handleTool: ToolHandler) {
    let pending: FunctionCall | undefined;
    for (const action of session.required_actions) {
      if (action.type !== "function_call")
        throw new Error("The mission session requested an unexpected environment connection.");
      if (action.turn_id === ref.previousTurnId || (ref.turnId && action.turn_id !== ref.turnId))
        continue;
      ref.turnId = action.turn_id;
      const result =
        ref.results.get(action.call_id) ?? (await abortable(handleTool(action), this.signal()));
      if (result === null) {
        if (pending) throw new Error("The Director submitted multiple simultaneous plans.");
        pending = action;
        continue;
      }
      ref.results.set(action.call_id, result);
      this.checkpoint();
      await this.client.beta.agents.sessions.events.create(
        ref.id!,
        { events: [result] },
        this.options()
      );
    }
    this.checkpoint();
    return pending;
  }

  private async savedText(ref: SessionRef) {
    let text = "";
    for await (const item of this.client.beta.agents.sessions.items.list(
      ref.id!,
      {
        order: "asc",
      },
      this.options()
    )) {
      if (
        item.type !== "message" ||
        item.turn_id !== ref.turnId ||
        item.role !== "assistant" ||
        item.phase !== "final_answer"
      )
        continue;
      text = item.content
        .filter((part) => part.type === "output_text")
        .map((part) => part.text)
        .join("");
    }
    return text;
  }

  private async consume(
    ref: SessionRef,
    initialEvents: Stream<AgentSessionEvent>,
    handleTool: ToolHandler
  ) {
    let events = initialEvents;
    let text = "";
    let calls = 0;
    const boundedHandler: ToolHandler = async (call) => {
      this.budget?.functionCall();
      if (++calls > 32) throw new Error("The mission assessment exceeded its function-call limit.");
      return handleTool(call);
    };
    // Reconnect before reconciling persisted state. Never resubmit user input.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt) {
          events = await this.client.beta.agents.sessions.events.stream(ref.id!, this.options());
          const session = await this.client.beta.agents.sessions.retrieve(ref.id!, this.options());
          if (session.status === "failed")
            throw new Error(session.error ?? "The mission session failed.");
          if (!ref.turnId) {
            for await (const turn of this.client.beta.agents.sessions.turns.list(
              ref.id!,
              {
                order: "desc",
              },
              this.options()
            )) {
              if (turn.subagent_id === null && turn.id !== ref.previousTurnId) {
                ref.turnId = turn.id;
                break;
              }
            }
          }
          if (ref.turnId) {
            const turn = await this.client.beta.agents.sessions.turns.retrieve(
              ref.turnId,
              {
                session_id: ref.id!,
              },
              this.options()
            );
            this.usage.record(ref.id! + ":" + turn.id, turn.usage, ref.model);
            if (turn.status === "completed") return { text: await this.savedText(ref) };
            if (turn.status === "failed" || turn.status === "cancelled")
              throw new Error(turn.error?.message ?? "The mission turn was " + turn.status + ".");
          }
          const pending = await this.requiredActions(ref, session, boundedHandler);
          if (pending) return { text, pending };
        }
        for await (const event of events) {
          this.budget?.check();
          const savedId = ref.id;
          if ("session" in event) ref.id = event.session.id;
          else if ("session_id" in event) ref.id = event.session_id;
          if (ref.id !== savedId) this.checkpoint();
          if (event.type === "error") throw new Error(event.error.message);
          if (
            event.type === "agent.session.failed" ||
            event.type === "agent.session.environment.failed"
          )
            throw new Error("The mission session failed.");
          if (
            "turn" in event &&
            event.turn.subagent_id === null &&
            event.turn.id !== ref.previousTurnId
          ) {
            ref.turnId ??= event.turn.id;
            this.checkpoint();
          }
          if ("turn" in event && event.turn.usage) {
            this.usage.record(ref.id! + ":" + event.turn.id, event.turn.usage, ref.model);
            this.budget?.check();
          }
          if (event.type === "agent.session.requires_action") {
            // Queued event snapshots can be stale after a tool result is accepted.
            const session = await this.client.beta.agents.sessions.retrieve(
              ref.id!,
              this.options()
            );
            const pending = await this.requiredActions(ref, session, boundedHandler);
            if (pending) return { text, pending };
          }
          if (event.type === "agent.session.turn.output_text.done" && event.turn_id === ref.turnId)
            text = event.text;
          if (event.type === "agent.session.turn.completed" && event.turn.id === ref.turnId) {
            this.usage.record(
              ref.id! + ":" + event.turn.id,
              event.turn.usage ?? event.usage,
              ref.model
            );
            this.budget?.check();
            this.checkpoint();
            return { text: (await this.savedText(ref)) || text };
          }
          if (
            (event.type === "agent.session.turn.failed" ||
              event.type === "agent.session.turn.cancelled") &&
            event.turn.id === ref.turnId
          )
            throw new Error(
              event.turn.error?.message ?? "The mission turn was " + event.turn.status + "."
            );
        }
      } catch (error) {
        // A transport failure is recoverable; application errors and failed turns
        // are terminal and must never be turned into an implicit retry.
        if (
          !(error instanceof OpenAI.APIConnectionError) &&
          !(error instanceof TypeError && /fetch|terminated|network/i.test(error.message))
        )
          throw error;
        if (!ref.id || attempt === 1) throw error;
      } finally {
        events.controller.abort();
      }
      if (!ref.id) break;
    }
    throw new Error(
      "The mission stream ended before the intended turn completed. Reassess before authorizing."
    );
  }

  async refreshUsage(refs: SessionRef[], signal?: AbortSignal) {
    // Seed every expected turn before a failed listing can interrupt reconciliation.
    for (const ref of refs)
      if (ref.id && ref.turnId) this.usage.record(ref.id + ":" + ref.turnId, null, ref.model);
    for (const ref of refs) {
      if (!ref.id) continue;
      for await (const turn of this.client.beta.agents.sessions.turns.list(
        ref.id,
        {},
        signal ? { signal, maxRetries: 0 } : this.options()
      ))
        this.usage.record(ref.id + ":" + turn.id, turn.usage, ref.model);
    }
  }

  async cancel(ref: SessionRef, confirmationMilliseconds = cancellationConfirmationMilliseconds()) {
    if (!ref.id) return;
    if (!Number.isFinite(confirmationMilliseconds) || confirmationMilliseconds <= 0)
      throw new Error("Cancellation confirmation deadline must be positive.");
    const sessionId = ref.id,
      turnId = ref.turnId;
    // Cleanup must work even after the investigation/consultation signal aborts.
    // One wall-clock bound covers retrieval, cancellation, and confirmation.
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new Error("Remote stop could not be confirmed before the cancellation deadline.")
        ),
      confirmationMilliseconds
    );
    const options = { timeout: confirmationMilliseconds, maxRetries: 0, signal: controller.signal };
    const bounded = <T>(operation: Promise<T>) => abortable(operation, controller.signal);
    let requested = false;
    const requestCancellation = async () => {
      if (requested) return;
      await bounded(
        this.client.beta.agents.sessions.events.create(
          sessionId,
          {
            events: [{ type: "agent.session.input.cancel" }],
          },
          options
        )
      );
      requested = true;
    };
    try {
      for (;;) {
        controller.signal.throwIfAborted();
        const session = await bounded(
          this.client.beta.agents.sessions.retrieve(sessionId, options)
        );
        // Stop known-active work before a turn lookup that could itself fail.
        if (session.status === "in_progress" || session.status === "requires_action")
          await requestCancellation();
        const turn = turnId
          ? await bounded(
              this.client.beta.agents.sessions.turns.retrieve(
                turnId,
                { session_id: sessionId },
                options
              )
            )
          : undefined;
        controller.signal.throwIfAborted();
        const inactive = session.status === "idle" || session.status === "failed";
        const terminal =
          !turnId || (turn && ["completed", "failed", "cancelled"].includes(turn.status));
        if (inactive && terminal) return;
        await requestCancellation();
        await bounded(new Promise<void>((resolve) => setTimeout(resolve, 100)));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async dispose(ref: SessionRef) {
    if (!ref.id) return;
    let session: AgentSession;
    try {
      session = await this.client.beta.agents.sessions.retrieve(ref.id);
    } catch (error) {
      if (error instanceof OpenAI.APIError && error.status === 404) return;
      throw error;
    }
    if (session.status === "in_progress" || session.status === "requires_action")
      await this.client.beta.agents.sessions.events.create(ref.id, {
        events: [{ type: "agent.session.input.cancel" }],
      });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.client.beta.agents.sessions.delete(ref.id);
        return;
      } catch (error) {
        if (error instanceof OpenAI.APIError && error.status === 404) return;
        if (!(error instanceof OpenAI.APIError) || error.status !== 409 || attempt === 2)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
}
