import { missionActions } from "../server/mission.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import type { AgentSessionEvent, TokenUsage } from "openai/resources/beta/agents/agents";
import {
  AgentsApi,
  ConsultationTimeoutError,
  toolResult,
  type FunctionCall,
  type SessionRef,
} from "../server/agents-api.js";
import { MissionUsageCollector } from "../server/mission-usage.js";
import { validateMissionPlan, validateAuthorizedPlan } from "../server/agents.js";
import { createMission } from "../server/mission.js";

const usage: TokenUsage = {
  input_tokens: 1000,
  input_tokens_details: { cached_tokens: 100 },
  output_tokens: 500,
  output_tokens_details: { reasoning_tokens: 300 },
  total_tokens: 1500,
};
const call: FunctionCall = {
  type: "function_call",
  turn_id: "turn-1",
  call_id: "call-1",
  name: "submit_mission_plan",
  arguments: { actions: ["recall_eva"] },
};
const turn = (status = "completed") => ({
  id: "turn-1",
  subagent_id: null,
  status,
  usage,
  error: null,
});
const created = {
  type: "agent.session.turn.created",
  session_id: "sess-1",
  turn: turn("in_progress"),
};
const completed = {
  type: "agent.session.turn.completed",
  session_id: "sess-1",
  turn: turn(),
  usage,
};
const requiresAction = { type: "agent.session.requires_action", session: { id: "sess-1" } };

function fixture(initial: unknown[], resumed: unknown[] = [completed]) {
  const operations: string[] = [];
  const submissions: unknown[] = [];
  let pending: FunctionCall[] = [call];
  let status = "completed";
  const stream = (events: unknown[]) => ({
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        if (event instanceof Error) throw event;
        yield event as AgentSessionEvent;
      }
    },
  });
  const client = {
    beta: {
      agents: {
        sessions: {
          create: async (params: unknown) => {
            operations.push("start");
            submissions.push(params);
            return stream(initial);
          },
          retrieve: async () => ({
            id: "sess-1",
            status: pending.length ? "requires_action" : "idle",
            required_actions: pending,
          }),
          delete: async () => {
            operations.push("delete");
          },
          events: {
            stream: async () => {
              operations.push("subscribe");
              return stream(resumed);
            },
            create: async (paramsId: string, params: { events: unknown[] }) => {
              assert.equal(paramsId, "sess-1");
              operations.push("submit");
              submissions.push(params);
              if ((params.events[0] as { type: string }).type === "agent.session.input.tool_result")
                pending = [];
            },
          },
          items: {
            list: async function* () {
              yield {
                type: "message",
                turn_id: "old-turn",
                role: "assistant",
                phase: "final_answer",
                content: [{ type: "output_text", text: "wrong old output" }],
              };
              yield {
                type: "message",
                turn_id: "turn-1",
                role: "assistant",
                phase: "final_answer",
                content: [{ type: "output_text", text: "saved final output" }],
              };
            },
          },
          turns: {
            retrieve: async () => turn(status),
            list: async function* () {
              yield turn(status);
            },
          },
        },
      },
    },
  } as unknown as OpenAI;
  const collector = new MissionUsageCollector();
  const api = new AgentsApi(client, collector);
  const ref: SessionRef = { model: "gpt-6-sol", results: new Map() };
  return {
    api,
    ref,
    collector,
    operations,
    submissions,
    setStatus: (value: string) => {
      status = value;
    },
    clearPending: () => {
      pending = [];
    },
  };
}

test("pending authorization does not submit a tool result; resumption subscribes before deciding", async () => {
  const f = fixture([created, requiresAction]);
  const paused = await f.api.start(f.ref, { model: "gpt-6-sol" }, "Assess", async () => null);
  assert.equal(paused.pending?.call_id, call.call_id);
  assert.deepEqual(f.operations, ["start"]);
  assert.equal(f.ref.id, "sess-1");
  assert.equal(f.ref.turnId, "turn-1");
  const resumed = await f.api.resume(f.ref, toolResult(call, { approved: true }), async () => {
    throw new Error("No extra tool expected");
  });
  assert.deepEqual(f.operations, ["start", "subscribe", "submit"]);
  assert.equal(resumed.text, "saved final output");
  const result = (f.submissions[1] as { events: { turn_id: string; call_id: string }[] }).events[0];
  assert.equal(result.turn_id, "turn-1");
  assert.equal(result.call_id, "call-1");
});

test("function responders keep running after an idle event and submit exact call identifiers", async () => {
  const f = fixture([
    created,
    { type: "agent.session.idle", session: { id: "sess-1" } },
    requiresAction,
    completed,
  ]);
  let calls = 0;
  const result = await f.api.start(f.ref, { model: "gpt-6-sol" }, "Assess", async (action) => {
    calls++;
    return toolResult(action, { telemetry: "nominal" });
  });
  assert.equal(calls, 1);
  assert.equal(result.text, "saved final output");
  assert.equal(f.collector.summary().requests, 1);
});

test("failed and cancelled turns never return a successful result", async () => {
  for (const status of ["failed", "cancelled"]) {
    const f = fixture([
      created,
      { type: "agent.session.turn." + status, session_id: "sess-1", turn: turn(status) },
    ]);
    await assert.rejects(
      () => f.api.start(f.ref, { model: "gpt-6-sol" }, "Assess", async () => null),
      /mission turn was/
    );
  }
});

test("an early EOF reconnects and reconciles persisted turn output without resubmitting input", async () => {
  const f = fixture([created]);
  f.clearPending();
  const result = await f.api.start(f.ref, { model: "gpt-6-sol" }, "Assess", async () => null);
  assert.equal(result.text, "saved final output");
  assert.deepEqual(f.operations, ["start", "subscribe"]);
  assert.equal(f.submissions.length, 1);
});

test("idle plus an unfinished saved turn never establishes completion", async () => {
  const f = fixture([created, { type: "agent.session.idle", session: { id: "sess-1" } }], []);
  f.clearPending();
  f.setStatus("in_progress");
  await assert.rejects(
    () => f.api.start(f.ref, { model: "gpt-6-sol" }, "Assess", async () => null),
    /before the intended turn completed/
  );
});

test("late usage replaces a turn snapshot and missing usage withholds total cost", () => {
  const collector = new MissionUsageCollector();
  collector.record("turn-1", null, "gpt-6-sol");
  assert.equal(collector.summary().accountingPending, true);
  assert.equal(collector.summary().estimatedCostUsd, undefined);
  collector.record("turn-1", usage, "gpt-6-sol");
  collector.record("turn-1", { ...usage, output_tokens: 1000, total_tokens: 2000 }, "gpt-6-sol");
  const summary = collector.summary();
  assert.equal(summary.requests, 1);
  assert.equal(summary.outputTokens, 1000);
  assert.equal(summary.visibleOutputTokens, 700);
  assert.equal(summary.accountingPending, false);
  assert.equal(summary.estimatedCostUsd, 0.01182);
  collector.record("turn-2", usage, "unpriced-model");
  assert.equal(collector.summary().estimatedCostUsd, undefined);
});

test("plan validation allows ineffective proposals but rejects unsupported and duplicate commands", () => {
  const mission = createMission();
  const plan = {
    headline: "Safe response",
    actions: ["recall_eva"] as (typeof missionActions)[number][],
    rationale: "Protect crew",
    uncertainties: [],
    approvalScope: "Approve these actions",
  };
  assert.deepEqual(validateMissionPlan(mission, plan), plan);
  assert.deepEqual(
    validateMissionPlan(mission, { ...plan, actions: ["verify_orbital_weather"] }).actions,
    ["verify_orbital_weather"]
  );
  assert.throws(
    () => validateMissionPlan(mission, { ...plan, actions: ["recall_eva", "recall_eva"] }),
    /duplicate/
  );
  assert.throws(
    () => validateMissionPlan(mission, { ...plan, actions: ["switch_to_backup_relay"] }),
    /unavailable/
  );
  assert.throws(() =>
    validateMissionPlan(mission, { ...plan, actions: [...plan.actions, "launch_missile"] })
  );
});

test("authorization requires exactly the submitted plan, including its rationale and scope", () => {
  const state = createMission();
  const plan = {
    headline: "Protect the crew",
    actions: ["recall_eva"] as (typeof missionActions)[number][],
    rationale: "Life support comes first",
    uncertainties: [],
    approvalScope: "Authorize these actions",
  };
  assert.deepEqual(validateAuthorizedPlan(state, plan, JSON.stringify(plan)), plan);
  assert.throws(
    () =>
      validateAuthorizedPlan(state, plan, {
        ...plan,
        approvalScope: "Authorize additional actions",
      }),
    /changed the authorized/
  );
  assert.throws(
    () => validateAuthorizedPlan(state, plan, { ...plan, rationale: "A different rationale" }),
    /changed the authorized/
  );
});

test("transport failure reconnects without replaying input or approving a call", async () => {
  const f = fixture([created, new OpenAI.APIConnectionError({ message: "Connection closed" })]);
  f.clearPending();
  const result = await f.api.start(f.ref, { model: "gpt-6-sol" }, "Assess", async () => null);
  assert.equal(result.text, "saved final output");
  assert.deepEqual(f.operations, ["start", "subscribe"]);
});

test("follow-up tracks its new turn and ignores a queued completion from the previous turn", async () => {
  const next = { ...turn(), id: "turn-2" };
  const f = fixture(
    [created, completed],
    [
      completed,
      {
        type: "agent.session.turn.created",
        session_id: "sess-1",
        turn: { ...next, status: "in_progress" },
      },
      {
        type: "agent.session.turn.output_text.done",
        session_id: "sess-1",
        turn_id: "turn-2",
        text: "new final",
      },
      { type: "agent.session.turn.completed", session_id: "sess-1", turn: next, usage },
    ]
  );
  await f.api.start(f.ref, { model: "gpt-6-sol" }, "Assess", async () => null);
  const result = await f.api.send(f.ref, "Review", async () => null);
  assert.equal(result.text, "new final");
  assert.equal(f.ref.turnId, "turn-2");
  assert.deepEqual(f.operations, ["start", "subscribe", "submit"]);
});

test("cleanup cancels required actions before deleting the API session", async () => {
  const f = fixture([created, requiresAction]);
  await f.api.start(f.ref, { model: "gpt-6-sol" }, "Assess", async () => null);
  await f.api.dispose(f.ref);
  assert.deepEqual(f.operations, ["start", "submit", "delete"]);
  assert.equal(
    (f.submissions[1] as { events: { type: string }[] }).events[0].type,
    "agent.session.input.cancel"
  );
});

test("specialist deadlines abort and cancel only the expired hosted consultation without retrying", async () => {
  const signals = new Map<string, AbortSignal>();
  const cancelled: string[] = [];
  let starts = 0;
  const client = {
    beta: {
      agents: {
        sessions: {
          create: async (params: { input: string }, options: { signal: AbortSignal }) => {
            starts++;
            const id = params.input;
            signals.set(id, options.signal);
            return {
              controller: new AbortController(),
              async *[Symbol.asyncIterator]() {
                yield { ...created, session_id: id };
                if (id === "slow")
                  await new Promise((_resolve, reject) =>
                    options.signal.addEventListener("abort", () => reject(options.signal.reason), {
                      once: true,
                    })
                  );
                else {
                  await new Promise((resolve) => setTimeout(resolve, 25));
                  yield { ...completed, session_id: id };
                }
              },
            };
          },
          retrieve: async (id: string) => ({
            status: cancelled.includes(id) ? "idle" : "in_progress",
          }),
          turns: { retrieve: async () => ({ status: "cancelled" }) },
          events: {
            create: async (id: string, body: { events: Array<{ type: string }> }) => {
              assert.equal(body.events[0].type, "agent.session.input.cancel");
              cancelled.push(id);
            },
          },
          items: {
            list: async function* () {
              yield {
                type: "message",
                turn_id: "turn-1",
                role: "assistant",
                phase: "final_answer",
                content: [{ type: "output_text", text: "valid report" }],
              };
            },
          },
        },
      },
    },
  } as unknown as OpenAI;
  const api = new AgentsApi(client, new MissionUsageCollector());
  const slow: SessionRef = { model: "gpt-6-sol", role: "Risk Review", results: new Map() };
  const fast: SessionRef = { model: "gpt-6-sol", role: "Life Support", results: new Map() };
  const start = (ref: SessionRef, input: string) =>
    api.start(ref, { model: ref.model }, input, async () => null);
  const [expired, healthy] = await Promise.allSettled([
    api.withConsultationDeadline(slow, 10, () => start(slow, "slow")),
    api.withConsultationDeadline(fast, 200, () => start(fast, "fast")),
  ]);
  assert.equal(expired.status, "rejected");
  if (expired.status === "rejected") assert(expired.reason instanceof ConsultationTimeoutError);
  assert.equal(healthy.status, "fulfilled");
  assert.equal(signals.get("slow")?.aborted, true);
  assert.equal(signals.get("fast")?.aborted, false);
  assert.deepEqual(cancelled, ["slow"]);
  assert.equal(starts, 2);
});

test("specialist limit reserves shared time and validates configuration", async () => {
  const { specialistDeadlineMilliseconds } = await import("../server/investigation-budget.js");
  assert.equal(specialistDeadlineMilliseconds({}), 120000);
  assert.equal(
    specialistDeadlineMilliseconds({
      MISSION_INVESTIGATION_SECONDS: "40",
      MISSION_SPECIALIST_SECONDS: "100",
    }),
    30000
  );
  assert.throws(
    () => specialistDeadlineMilliseconds({ MISSION_SPECIALIST_SECONDS: "0" }),
    /positive/
  );
});

test("failed cancellation and shared budget exhaustion never become recoverable timeouts", async (t) => {
  const { InvestigationBudget } = await import("../server/investigation-budget.js");
  const api = new AgentsApi({} as OpenAI, new MissionUsageCollector());
  const ref: SessionRef = {
    id: "timeout",
    model: "gpt-6-luna",
    role: "Power & Thermal",
    results: new Map(),
  };
  const never = () => new Promise<never>(() => {});
  const cancel = t.mock.method(api, "cancel", async () => {
    throw new Error("Cancel unavailable");
  });
  await assert.rejects(api.withConsultationDeadline(ref, 5, never), (error) => {
    assert(error instanceof Error && !(error instanceof ConsultationTimeoutError));
    assert.match(error.message, /cancellation could not be confirmed/);
    return true;
  });
  const budget = new InvestigationBudget();
  api.budget = budget;
  cancel.mock.mockImplementation(async () => {
    budget.stop("Shared budget exhausted");
  });
  try {
    await assert.rejects(api.withConsultationDeadline(ref, 5, never), /Shared budget exhausted/);
  } finally {
    budget.finish();
  }
});

function cancellationFixture(states: Array<{ session: string; turn: string }>) {
  let index = 0,
    requests = 0;
  const options: Array<{ maxRetries: number; signal: AbortSignal }> = [];
  const api = new AgentsApi(
    {
      beta: {
        agents: {
          sessions: {
            retrieve: async (_id: string, opts: { maxRetries: number; signal: AbortSignal }) => {
              options.push(opts);
              return { status: states[Math.min(index, states.length - 1)].session };
            },
            turns: {
              retrieve: async (id: string, params: { session_id: string }) => {
                assert.equal(id, "turn-under-test");
                assert.equal(params.session_id, "session-under-test");
                return { status: states[Math.min(index++, states.length - 1)].turn };
              },
            },
            events: {
              create: async () => {
                requests++;
              },
            },
          },
        },
      },
    } as unknown as OpenAI,
    new MissionUsageCollector()
  );
  const ref: SessionRef = {
    id: "session-under-test",
    turnId: "turn-under-test",
    model: "gpt-6-luna",
    results: new Map(),
  };
  return { api, ref, options, requests: () => requests, reads: () => index };
}

test("cancellation waits for BOTH an inactive session and the exact terminal turn", async () => {
  const f = cancellationFixture([
    { session: "requires_action", turn: "waiting" },
    { session: "idle", turn: "in_progress" },
    { session: "in_progress", turn: "cancelled" },
    { session: "idle", turn: "cancelled" },
  ]);
  await f.api.cancel(f.ref);
  assert.equal(f.requests(), 1);
  assert.equal(f.reads(), 4);
  assert(f.options.every((o) => o.maxRetries === 0 && !o.signal.aborted));
});

for (const terminal of ["completed", "failed", "cancelled"]) {
  test(`already-stopped ${terminal} turn needs no cancellation request`, async () => {
    const f = cancellationFixture([{ session: "idle", turn: terminal }]);
    await f.api.cancel(f.ref);
    assert.equal(f.requests(), 0);
  });
}

test("acknowledgment alone and hung status retrieval hit the overall confirmation deadline", async (t) => {
  const f = cancellationFixture([{ session: "in_progress", turn: "waiting" }]);
  await assert.rejects(f.api.cancel(f.ref, 20), /could not be confirmed/);
  assert.equal(f.requests(), 1);
  assert(f.options[0].signal.aborted);
  t.mock.method(f.api.client.beta.agents.sessions, "retrieve", () => new Promise(() => {}));
  await assert.rejects(f.api.cancel(f.ref, 20), /could not be confirmed/);
  assert.equal(f.requests(), 1, "Hung retrieval must not start another cancel operation");
});

test("status lookup errors are not mistaken for confirmed cancellation", async (t) => {
  const f = cancellationFixture([{ session: "idle", turn: "completed" }]);
  t.mock.method(f.api.client.beta.agents.sessions.turns, "retrieve", async () => {
    throw new Error("Turn not found");
  });
  await assert.rejects(f.api.cancel(f.ref), /Turn not found/);
});

test("a deadline before session identification cannot claim a confirmed remote stop", async () => {
  const api = new AgentsApi({} as OpenAI, new MissionUsageCollector());
  const ref: SessionRef = { model: "gpt-6-luna", results: new Map() };
  await assert.rejects(
    api.withConsultationDeadline(ref, 5, () => new Promise(() => {})),
    /cancellation could not be confirmed/
  );
});

test("stop confirmation remains available after the shared investigation budget aborts", async () => {
  const { InvestigationBudget } = await import("../server/investigation-budget.js");
  const f = cancellationFixture([
    { session: "in_progress", turn: "waiting" },
    { session: "failed", turn: "failed" },
  ]);
  const budget = new InvestigationBudget();
  f.api.budget = budget;
  budget.stop("Investigation expired");
  try {
    await f.api.cancel(f.ref);
    assert.equal(f.requests(), 1);
    assert(f.options.every((option) => !option.signal.aborted));
  } finally {
    budget.finish();
  }
});

test("known-active work receives cancel even when turn-status lookup fails", async (t) => {
  const f = cancellationFixture([{ session: "in_progress", turn: "waiting" }]);
  t.mock.method(f.api.client.beta.agents.sessions.turns, "retrieve", async () => {
    throw new Error("Status unavailable");
  });
  await assert.rejects(f.api.cancel(f.ref), /Status unavailable/);
  assert.equal(f.requests(), 1);
});

test("stop confirmation allows an idle transition near the former five-second limit", async (t) => {
  const { cancellationConfirmationMilliseconds } =
    await import("../server/investigation-budget.js");
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const f = cancellationFixture([{ session: "requires_action", turn: "waiting" }]);
  t.mock.method(f.api.client.beta.agents.sessions, "retrieve", async () => ({
    status: Date.now() >= 4978 ? "idle" : "requires_action",
  }));
  t.mock.method(f.api.client.beta.agents.sessions.turns, "retrieve", async () => {
    if (Date.now() < 4978) return { status: "waiting" };
    await new Promise((done) => setTimeout(done, 300));
    return { status: "cancelled" };
  });
  const result = f.api.cancel(f.ref, cancellationConfirmationMilliseconds({}));
  const flush = () => new Promise<void>((done) => setImmediate(done));
  await flush();
  t.mock.timers.tick(4978);
  await flush();
  t.mock.timers.tick(300);
  await result;
  assert.equal(Date.now(), 5278);
  assert.equal(f.requests(), 1);
});

test("cancellation configuration is finite, positive, capped, and separate from investigation time", async () => {
  const { cancellationConfirmationMilliseconds } =
    await import("../server/investigation-budget.js");
  assert.equal(cancellationConfirmationMilliseconds({}), 15000);
  assert.equal(
    cancellationConfirmationMilliseconds({
      MISSION_CANCELLATION_SECONDS: "20",
      MISSION_INVESTIGATION_SECONDS: "1",
    }),
    20000
  );
  for (const value of ["0", "-1", "NaN", "Infinity", "61"])
    assert.throws(
      () => cancellationConfirmationMilliseconds({ MISSION_CANCELLATION_SECONDS: value }),
      /MISSION_CANCELLATION_SECONDS/
    );
});

test("a hung cancellation request still fails at its configured deadline", async (t) => {
  const f = cancellationFixture([{ session: "requires_action", turn: "waiting" }]);
  t.mock.method(f.api.client.beta.agents.sessions.events, "create", () => new Promise(() => {}));
  await assert.rejects(f.api.cancel(f.ref, 20), /could not be confirmed/);
});

test("an expected turn omitted from the usage listing remains pending until accounted", async () => {
  const collector = new MissionUsageCollector();
  let include = false;
  const api = new AgentsApi(
    {
      beta: {
        agents: {
          sessions: {
            turns: {
              list: async function* () {
                if (include) yield { id: "expected", usage };
              },
            },
          },
        },
      },
    } as unknown as OpenAI,
    collector
  );
  const refs: SessionRef[] = [
    { id: "session", turnId: "expected", model: "gpt-6-luna", results: new Map() },
  ];
  await api.refreshUsage(refs);
  assert.equal(collector.summary().accountingPending, true);
  assert.equal(collector.summary().estimatedCostUsd, undefined);
  assert.deepEqual(collector.snapshot().missing, ["session:expected"]);
  include = true;
  await api.refreshUsage(refs);
  assert.equal(collector.summary().accountingPending, false);
  assert.equal(collector.summary().totalTokens, usage.total_tokens);
  include = false;
  await api.refreshUsage(refs);
  assert.equal(
    collector.summary().accountingPending,
    false,
    "A later omitted page cannot erase known usage"
  );
});
