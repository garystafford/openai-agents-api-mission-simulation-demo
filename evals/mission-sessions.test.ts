import { advanceMission, requestCommand, approveCommand } from "../server/mission.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentsApi,
  ConsultationTimeoutError,
  type SessionRef,
  type FunctionCall,
} from "../server/agents-api.js";
import { MissionSessions } from "../server/mission-sessions.js";
import { agentProfiles, type AgentProfileName } from "../server/agent-profiles.js";
import {
  clearMissionSession,
  runMissionDirector,
  pendingMissionApproval,
} from "../server/agents.js";
import { createMission } from "../server/mission.js";
import { parseBatchConsultations } from "../server/agent-schemas.js";
import { legacySpecialistNames } from "../server/mission-team.js";

function fixture() {
  const starts: { ref: SessionRef; input: string }[] = [];
  const followups: { ref: SessionRef; input: string }[] = [];
  const conversations = new Map<string, string[]>();
  let rejectFollowup = false;
  const api: Pick<AgentsApi, "start" | "send"> = {
    start: async (ref, agent, input) => {
      assert.equal(agent.model, ref.model);
      ref.id = "session-" + (starts.length + 1);
      ref.turnId = "turn-1";
      starts.push({ ref, input });
      conversations.set(ref.id, [input]);
      return { text: input };
    },
    send: async (ref, input) => {
      followups.push({ ref, input });
      if (rejectFollowup) throw new Error("Follow-up failed");
      const history = conversations.get(ref.id!)!;
      history.push(input);
      ref.previousTurnId = ref.turnId;
      ref.turnId = "turn-" + history.length;
      return { text: history.join(" | ") };
    },
  };
  const run = (sessions: MissionSessions, role: AgentProfileName, input: string) =>
    sessions.run(role, { model: agentProfiles[role].model }, input, async () => null);
  return {
    api,
    run,
    starts,
    followups,
    rejectFollowup: () => {
      rejectFollowup = true;
    },
  };
}

test("saved call-sign sessions continue under role names without creating replacement sessions", async () => {
  const f = fixture();
  for (const [oldName, name] of Object.entries(legacySpecialistNames)) {
    const initial = new MissionSessions("mission-one", f.api);
    await f.run(initial, name, "Initial evidence");
    const ref = initial.ref(name);
    const id = ref.id;
    ref.role = oldName;
    const restored = new MissionSessions("mission-one", f.api, [ref]);
    const result = await f.run(restored, name, "Follow up");
    assert.equal(restored.ref(name).id, id);
    assert.equal(restored.ref(name).role, name);
    assert.equal(restored.all().length, 1);
    assert.match(result.text, /Initial evidence.*Follow up/);
  }
  assert.equal(f.starts.length, 4);
  assert.equal(f.followups.length, 4);
});

test("restored Director tool calls accept legacy roles and reject aliases duplicated in one batch", () => {
  const result = parseBatchConsultations({
    consultations: [
      { specialist: "NOVA", question: "Assess power" },
      { specialist: "Weather & Navigation", question: "Assess weather" },
    ],
  });
  assert.equal(result.success, true);
  if (result.success)
    assert.deepEqual(
      result.data.consultations.map((entry) => entry.specialist),
      ["Power & Thermal", "Weather & Navigation"]
    );
  assert.equal(
    parseBatchConsultations({
      consultations: [
        { specialist: "NOVA", question: "Assess power" },
        { specialist: "Power & Thermal", question: "Duplicate role" },
      ],
    }).success,
    false
  );
  assert.equal(
    parseBatchConsultations({
      consultations: [
        { specialist: "Unknown", question: "Assess" },
        { specialist: "Risk Review", question: "Review" },
      ],
    }).success,
    false
  );
});

test("specialist sessions are lazy and follow-ups retain the same conversation and reference", async () => {
  const f = fixture();
  const sessions = new MissionSessions("mission-one", f.api);
  assert.equal(sessions.all().length, 0);
  await f.run(sessions, "Power & Thermal", "Analyze the power reserve");
  const first = sessions.ref("Power & Thermal");
  const result = await f.run(sessions, "Power & Thermal", "Reconsider your earlier power analysis");
  assert.equal(f.starts.length, 1);
  assert.equal(f.followups.length, 1);
  assert.equal(first, f.followups[0].ref);
  assert.equal(first, sessions.ref("Power & Thermal"));
  assert.equal(first.missionId, "mission-one");
  assert.equal(first.previousTurnId, "turn-1");
  assert.equal(first.turnId, "turn-2");
  assert.match(result.text, /Analyze the power reserve.*Reconsider your earlier power analysis/);
});

test("different roles overlap while simultaneous calls to one role use ordered turns", async () => {
  const f = fixture();
  const start = f.api.start;
  let release!: () => void;
  let markStarted!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  f.api.start = async (...args) => {
    if (args[0].role === "Power & Thermal") {
      markStarted();
      await held;
    }
    return start(...args);
  };
  const sessions = new MissionSessions("mission-one", f.api);
  const first = f.run(sessions, "Power & Thermal", "Initial power analysis");
  await started;
  const followup = f.run(sessions, "Power & Thermal", "Power follow-up");
  try {
    await f.run(sessions, "Weather & Navigation", "Independent weather analysis");
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0].ref.role, "Weather & Navigation");
    assert.equal(f.followups.length, 0);
  } finally {
    release();
    await first;
    await followup;
  }
  assert.equal(f.starts.filter((entry) => entry.ref.role === "Power & Thermal").length, 1);
  assert.equal(f.followups.length, 1);
  assert.equal(f.followups[0].ref, sessions.ref("Power & Thermal"));
});

test("Director and specialists keep separate sessions and role-specific models within a mission", async () => {
  const f = fixture();
  const sessions = new MissionSessions("mission-one", f.api);
  for (const role of Object.keys(agentProfiles) as AgentProfileName[]) {
    await f.run(sessions, role, role + " initial assessment");
    const result = await f.run(sessions, role, role + " reassessment");
    assert.equal(result.text, role + " initial assessment | " + role + " reassessment");
    assert.equal(sessions.ref(role).model, agentProfiles[role].model);
  }
  assert.equal(f.starts.length, 5);
  assert.equal(f.followups.length, 5);
  const cleanupRefs = sessions.all();
  assert.equal(cleanupRefs.length, 5);
  assert.equal(new Set(cleanupRefs.map((ref) => ref.id)).size, 5);
});

test("a new mission starts fresh even for the same role and incident question", async () => {
  const f = fixture();
  const firstMission = new MissionSessions("mission-one", f.api);
  const nextMission = new MissionSessions("mission-two", f.api);
  await f.run(firstMission, "Power & Thermal", "Earlier mission evidence");
  const result = await f.run(nextMission, "Power & Thermal", "Assess this new mission");
  assert.equal(f.starts.length, 2);
  assert.equal(f.followups.length, 0);
  assert.equal(result.text, "Assess this new mission");
  assert.notEqual(firstMission.ref("Power & Thermal").id, nextMission.ref("Power & Thermal").id);
  assert.notEqual(
    firstMission.ref("Power & Thermal").results,
    nextMission.ref("Power & Thermal").results
  );
  assert.equal(firstMission.ref("Power & Thermal").missionId, "mission-one");
  assert.equal(nextMission.ref("Power & Thermal").missionId, "mission-two");
});

test("a failed follow-up propagates instead of silently replacing the specialist session", async () => {
  const f = fixture();
  const sessions = new MissionSessions("mission-one", f.api);
  await f.run(sessions, "Power & Thermal", "Initial assessment");
  const originalId = sessions.ref("Power & Thermal").id;
  f.rejectFollowup();
  await assert.rejects(() => f.run(sessions, "Power & Thermal", "Follow-up"), /Follow-up failed/);
  assert.equal(f.starts.length, 1);
  assert.equal(sessions.ref("Power & Thermal").id, originalId);
  assert.equal(sessions.all().length, 1);
});

test("parallel batches reuse sessions, refresh MCP evidence, reject duplicate roles, and drain failures before cleanup", async (t) => {
  const state = createMission();
  const plan = {
    headline: "Protect crew",
    actions: [
      "recall_eva",
      "isolate_scrubber",
      "shed_nonessential_load",
    ] as import("../server/mission.js").MissionAction[],
    rationale: "Use current evidence",
    uncertainties: [],
    approvalScope: "Simulated actions only",
  };
  let evidenceState = state;
  const starts: { role: string; id: string }[] = [];
  const followups: { role: string; id: string }[] = [];
  const disposed: string[] = [];
  const cancelled: string[] = [];
  const evidence: string[] = [];
  const directorInputs: string[] = [];
  let active = 0;
  let maxActive = 0;
  let failPower = false;
  let callNumber = 0;
  const makeCall = (ref: SessionRef, name: string, args: unknown): FunctionCall => ({
    type: "function_call",
    call_id: "call-" + ++callNumber,
    turn_id: ref.turnId!,
    name,
    arguments: args,
  });
  const exercise = async (ref: SessionRef, handler: Parameters<AgentsApi["start"]>[3]) => {
    if (ref.role === "Mission Director") {
      const duplicate = await handler(
        makeCall(ref, "consult_specialists", {
          consultations: [
            { specialist: "Power & Thermal", question: "Assess power" },
            { specialist: "Power & Thermal", question: "Duplicate role" },
          ],
        })
      );
      assert.equal(duplicate?.success, false);
      const batch = await handler(
        makeCall(ref, "consult_specialists", {
          consultations: [
            { specialist: "Power & Thermal", question: "Assess power" },
            { specialist: "Weather & Navigation", question: "Assess weather independently" },
          ],
        })
      );
      assert(batch?.success);
      assert.deepEqual(
        JSON.parse(String(batch.output)).map((entry: { agent: string }) => entry.agent),
        ["Power & Thermal", "Weather & Navigation"]
      );
      assert.equal(active, 0);
      await handler(
        makeCall(ref, "consult_power", { question: "Reconsider your earlier recommendation" })
      );
      const rejectedPlan = await handler(
        makeCall(ref, "submit_mission_plan", { ...plan, actions: ["recall_eva", "recall_eva"] })
      );
      assert.equal(rejectedPlan?.success, false);
      if (rejectedPlan && !rejectedPlan.success) {
        assert(
          !rejectedPlan.error.includes("isolate_scrubber") &&
            !rejectedPlan.error.includes("shed_nonessential_load"),
          "Feedback may identify the submitted duplicate, but must not prescribe unsubmitted remedies"
        );
      }
      const pending = makeCall(ref, "submit_mission_plan", plan);
      assert.equal(await handler(pending), null);
      return { text: "", pending };
    }
    active++;
    maxActive = Math.max(maxActive, active);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (failPower && ref.role === "Power & Thermal") throw new Error("Test specialist failure");
      const result = await handler(makeCall(ref, "mcp_read_mission_telemetry", { system: "all" }));
      assert(result?.success);
      const envelope = JSON.parse(String(result.output));
      const payload = JSON.parse(
        envelope.content.find((item: { type: string }) => item.type === "text").text
      );
      assert.equal(
        payload.readings.find((item: { label: string }) => item.label === "Cabin oxygen")
          .sampledAtMinutes,
        evidenceState.simulation.elapsedMinutes
      );
      assert.equal(
        payload.readings.find((item: { label: string }) => item.label === "Cabin oxygen").history
          .length,
        evidenceState.simulation.elapsedMinutes === 0 ? 1 : 2
      );
      assert.equal(payload.conditions, undefined);
      assert.equal(
        payload.readings.find((reading: { metric: string }) => reading.metric === "oxygenPct")
          .numericValue,
        Math.round(evidenceState.simulation.conditions.oxygenPct * 1000) / 1000
      );
      evidence.push(String(result.output));
      return {
        text: JSON.stringify({
          status: "watch",
          confidence: 0.8,
          recommendation: "Protect the power reserve",
          evidence: [String(result.output)],
          tradeoff: "Reduce research loads",
        }),
      };
    } finally {
      active--;
    }
  };
  t.mock.method(AgentsApi.prototype, "start", async (ref: SessionRef, _agent, input, handler) => {
    ref.id = "integration-session-" + (starts.length + 1);
    ref.turnId = "initial-turn-" + ref.id;
    starts.push({ role: ref.role!, id: ref.id });
    if (ref.role === "Mission Director") directorInputs.push(input);
    return exercise(ref, handler);
  });
  t.mock.method(AgentsApi.prototype, "send", async (ref: SessionRef, _input, handler) => {
    followups.push({ role: ref.role!, id: ref.id! });
    ref.previousTurnId = ref.turnId;
    ref.turnId = "followup-turn-" + followups.length;
    return exercise(ref, handler);
  });
  t.mock.method(AgentsApi.prototype, "resume", async () => ({ text: JSON.stringify(plan) }));
  t.mock.method(AgentsApi.prototype, "refreshUsage", async () => {});
  t.mock.method(AgentsApi.prototype, "cancel", async (ref: SessionRef) => {
    assert.equal(active, 0);
    cancelled.push(ref.id!);
  });
  t.mock.method(AgentsApi.prototype, "dispose", async (ref: SessionRef) => {
    assert.equal(active, 0, "Cleanup must wait for every parallel consultation to settle");
    disposed.push(ref.id!);
  });
  const originalKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-only-no-network";
  try {
    const initial = await runMissionDirector(state);
    assert.equal(starts.length, 3);
    assert.equal(initial.reports.length, 2);
    assert.equal(maxActive, 2);
    assert.equal(followups.filter((entry) => entry.role === "Power & Thermal").length, 1);
    const updatedState = advanceMission(approveCommand(requestCommand(state, plan), true));
    evidenceState = updatedState;
    updatedState.selectedPlan = initial.plan;
    updatedState.telemetry[0].value = "UPDATED_READING";
    const review = await runMissionDirector(updatedState, undefined, undefined, "Review power");
    assert.equal(starts.length, 3);
    assert.equal(review.reports.length, 2);
    assert(
      review.reports
        .find((report) => report.agent === "Power & Thermal")!
        .evidence[0].includes("UPDATED_READING")
    );
    assert.equal(followups.filter((entry) => entry.role === "Power & Thermal").length, 3);
    assert.equal(
      new Set(
        followups.filter((entry) => entry.role === "Power & Thermal").map((entry) => entry.id)
      ).size,
      1
    );
    assert(evidence.slice(0, 3).every((output) => !output.includes("UPDATED_READING")));
    assert(evidence.slice(3).every((output) => output.includes("UPDATED_READING")));
    assert(
      review.log.some(
        (entry) => entry.speaker === "Power & Thermal" && /earlier findings/.test(entry.message)
      )
    );
    assert.notEqual(initial.proposalId, review.proposalId);
    await clearMissionSession(state.missionId);
    assert.equal(disposed.length, 3);
    assert.equal(new Set(disposed).size, 3);
    // Even a reused identifier must start clean after explicit session cleanup.
    const nextState = structuredClone(createMission());
    nextState.missionId = state.missionId;
    evidenceState = nextState;
    await runMissionDirector(nextState);
    assert.equal(
      directorInputs[0],
      directorInputs[1],
      "Equivalent fresh incidents should present the same evidence"
    );
    assert.equal(starts.length, 6);
    assert.equal(new Set(starts.map((entry) => entry.id)).size, 6);
    await clearMissionSession(state.missionId);
    assert.equal(disposed.length, 6);
    failPower = true;
    const failedState = createMission();
    await assert.rejects(() => runMissionDirector(failedState), /Test specialist failure/);
    assert.equal(active, 0);
    assert.equal(disposed.length, 6);
    assert.equal(cancelled.length, 3);
    await clearMissionSession(failedState.missionId);
    assert.equal(disposed.length, 9);
  } finally {
    await clearMissionSession(state.missionId);
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
  }
});

for (const mode of ["batch", "individual", "all-unavailable", "draft-after-timeout"] as const) {
  test(`timeout recovery: ${mode}; retains diagnostic evidence and blocks partial proposals`, async (t) => {
    const state = createMission();
    const before = structuredClone(state);
    const started: string[] = [];
    let id = 0;
    const plan = {
      headline: "Protect crew",
      actions: ["recall_eva"],
      rationale: "Current evidence",
      uncertainties: ["Unavailable assessment: Power & Thermal"],
      approvalScope: "Commander decision required",
    };
    const call = (ref: SessionRef, name: string, args: unknown): FunctionCall => ({
      type: "function_call",
      call_id: "recovery-" + ++id,
      turn_id: ref.turnId!,
      name,
      arguments: args,
    });
    const errorText = (reply: Awaited<ReturnType<Parameters<AgentsApi["start"]>[3]>>) => {
      assert(reply && !reply.success);
      return reply.error;
    };
    t.mock.method(
      AgentsApi.prototype,
      "start",
      async (ref: SessionRef, _agent, _input, handler) => {
        started.push(ref.role!);
        ref.id = "recovery-session-" + id++;
        ref.turnId = "recovery-turn-" + id;
        if (ref.role !== "Mission Director") {
          if (ref.role === "Power & Thermal" || mode === "all-unavailable")
            throw new ConsultationTimeoutError(ref.role!);
          assert(
            (await handler(call(ref, "mcp_read_mission_telemetry", { system: "all" })))?.success
          );
          const calc = { label: "forecast", terms: [[1], [2]] };
          const tooMany = await handler(
            call(ref, "mcp_check_arithmetic", { calculations: Array(16).fill(calc) })
          );
          assert.match(errorText(tooMany), /calculations.*8/);
          const tooLong = await handler(
            call(ref, "mcp_check_arithmetic", {
              calculations: [{ ...calc, label: "x".repeat(101) }],
            })
          );
          assert.match(errorText(tooLong), /calculations.0.label.*100/);
          const corrected = await handler(
            call(ref, "mcp_check_arithmetic", { calculations: [calc] })
          );
          assert(corrected?.success);
          assert.match(
            errorText(await handler(call(ref, "mcp_check_arithmetic", { calculations: [calc] }))),
            /limit reached/
          );
          return {
            text: JSON.stringify({
              status: "watch",
              confidence: 0.8,
              recommendation: "Protect crew",
              evidence: ["Fresh telemetry"],
              tradeoff: "Less research",
            }),
          };
        }
        if (mode === "individual") {
          assert(
            (await handler(call(ref, "consult_weather", { question: "Assess weather" })))?.success
          );
          assert.match(
            errorText(await handler(call(ref, "consult_power", { question: "Assess power" }))),
            /Unavailable assessment/
          );
        } else {
          const batch = await handler(
            call(ref, "consult_specialists", {
              consultations: [
                { specialist: "Power & Thermal", question: "Assess power" },
                { specialist: "Weather & Navigation", question: "Assess weather" },
              ],
            })
          );
          assert(batch?.success);
          const answers = JSON.parse(String(batch.output));
          assert.equal(answers[0].available, false);
          assert.match(answers[0].error, /Unavailable assessment: Power & Thermal/);
          if (mode !== "all-unavailable") assert.equal(answers[1].recommendation, "Protect crew");
        }
        assert.match(
          errorText(await handler(call(ref, "consult_power", { question: "Try again" }))),
          /No retry/
        );
        assert.match(
          errorText(
            await handler(
              call(ref, "consult_life_support", { question: "Replace missing expertise" })
            )
          ),
          /Assessment incomplete/
        );
        if (mode !== "draft-after-timeout") {
          for (const uncertainties of [[], plan.uncertainties]) {
            await assert.rejects(
              handler(call(ref, "submit_mission_plan", { ...plan, uncertainties })),
              /Assessment incomplete.*Power & Thermal/
            );
          }
        }
        return { text: JSON.stringify(plan) };
      }
    );
    t.mock.method(AgentsApi.prototype, "send", async () => {
      throw new Error("Unexpected retry");
    });
    t.mock.method(AgentsApi.prototype, "refreshUsage", async () => {});
    t.mock.method(AgentsApi.prototype, "cancel", async () => {});
    t.mock.method(AgentsApi.prototype, "dispose", async () => {});
    const key = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-only-no-network";
    try {
      const retained: import("../server/mission-contract.js").SpecialistReport[] = [];
      await assert.rejects(
        runMissionDirector(state, undefined, (report) => retained.push(report)),
        /Assessment incomplete.*Power & Thermal/
      );
      assert.equal(retained.length, mode === "all-unavailable" ? 0 : 1);
      if (retained.length) assert.equal(retained[0].agent, "Weather & Navigation");
      assert.equal(pendingMissionApproval(state.missionId), undefined);
      assert(!started.includes("Life Support"));
      assert.equal(started.filter((role) => role === "Power & Thermal").length, 1);
      assert.deepEqual(state, before, "Assessment must not execute actions");
    } finally {
      await clearMissionSession(state.missionId);
      if (key === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = key;
    }
  });
}
