import { testPlan } from "./fixtures.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DurableJson } from "../server/durable-json.js";
import { MissionStore, ownerKey, type MissionRecord } from "../server/mission-store.js";
import {
  InvestigationBudget,
  abortable,
  investigationLimits,
} from "../server/investigation-budget.js";
import { MissionUsageCollector } from "../server/mission-usage.js";
import {
  createMission,
  requestCommand,
  approveCommand,
  type DecisionPlan,
} from "../server/mission.js";
import { createMissionApp } from "../server/app.js";
import { accessConfig } from "../server/access.js";
import { MissionSessions } from "../server/mission-sessions.js";
import { planValidationFeedback, validateMissionPlan } from "../server/agents.js";

test("application defaults match the final evaluated model choices", () => {
  const env = { ...process.env };
  for (const prefix of [
    "MISSION_DIRECTOR",
    "POWER_THERMAL",
    "LIFE_SUPPORT",
    "WEATHER_NAVIGATION",
    "RISK_REVIEW",
    "NOVA",
    "AURA",
    "KEPLER",
    "MERCURY",
  ]) {
    // Empty values suppress dotenv loading local overrides while exercising defaults.
    env[prefix + "_MODEL"] = "";
    env[prefix + "_REASONING_EFFORT"] = "";
  }
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'import { publicAgentProfiles } from "./server/agent-profiles.ts"; console.log(JSON.stringify(publicAgentProfiles));',
    ],
    { encoding: "utf8", env }
  );
  const choices = JSON.parse(
    readFileSync(new URL("./promptfoo/final-model-choices.json", import.meta.url), "utf8")
  );
  assert.deepEqual(
    JSON.parse(output),
    Object.fromEntries(
      choices.profiles.map(
        ({
          role,
          model,
          reasoningEffort,
        }: {
          role: string;
          model: string;
          reasoningEffort: string;
        }) => [role, { model, reasoningEffort }]
      )
    )
  );
});

test("role-based model settings take precedence while legacy profile settings remain usable", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'import { publicAgentProfiles } from "./server/agent-profiles.ts"; console.log(JSON.stringify(publicAgentProfiles));',
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        NOVA_MODEL: "legacy-power",
        NOVA_REASONING_EFFORT: "low",
        POWER_THERMAL_MODEL: "role-power",
        POWER_THERMAL_REASONING_EFFORT: "high",
        AURA_MODEL: "legacy-air",
        AURA_REASONING_EFFORT: "medium",
        LIFE_SUPPORT_MODEL: "",
        LIFE_SUPPORT_REASONING_EFFORT: "",
        WEATHER_NAVIGATION_MODEL: "role-weather",
        WEATHER_NAVIGATION_REASONING_EFFORT: "low",
        RISK_REVIEW_MODEL: "role-risk",
        RISK_REVIEW_REASONING_EFFORT: "high",
      },
    }
  );
  const profiles = JSON.parse(output);
  assert.deepEqual(profiles["Power & Thermal"], { model: "role-power", reasoningEffort: "high" });
  assert.deepEqual(profiles["Life Support"], { model: "legacy-air", reasoningEffort: "medium" });
  assert.equal(profiles["Weather & Navigation"].model, "role-weather");
  assert.equal(profiles["Risk Review"].model, "role-risk");
  assert.deepEqual(Object.keys(profiles), [
    "Mission Director",
    "Power & Thermal",
    "Life Support",
    "Weather & Navigation",
    "Risk Review",
  ]);
});

test("durable restart retains approvals, sensor history and execution without replay", () => {
  const dir = mkdtempSync(join(tmpdir(), "ares-store-"));
  try {
    const key = ownerKey("browser");
    const store = new MissionStore(new DurableJson(dir));
    const record = store.load(key);
    record.state = createMission();
    record.state = requestCommand(record.state, testPlan(["recall_eva"]));
    record.state.proposalId = randomUUID();
    store.save(key, record);
    const restored = new MissionStore(new DurableJson(dir)).load(key);
    assert.deepEqual(restored.state, record.state);
    restored.state = approveCommand(restored.state, true);
    store.save(key, restored);
    assert.deepEqual(
      new MissionStore(new DurableJson(dir)).load(key).state,
      JSON.parse(JSON.stringify(restored.state))
    );
    assert.equal(restored.state.simulation.elapsedMinutes, 0);
    assert.equal(statSync(join(dir, key + ".json")).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("a crash in approval or assessment invalidates the proposal and never dispatches", () => {
  for (const kind of ["approval", "assessment"] as const) {
    const disk = new DurableJson<MissionRecord>();
    const key = ownerKey(kind);
    const store = new MissionStore(disk);
    const record = store.load(key);
    record.state = createMission();
    record.state = requestCommand(record.state, testPlan(["recall_eva"]));
    record.state.proposalId = randomUUID();
    record.operation = { kind, status: "running", startedAt: Date.now() };
    store.save(key, record);
    const recovered = new MissionStore(disk).load(key);
    assert.equal(recovered.operation?.status, "interrupted");
    assert.equal(recovered.state.phase, "assessment");
    assert.equal(recovered.state.proposalId, undefined);
    assert.equal(recovered.state.pendingCommand, undefined);
    assert.equal(recovered.state.simulation.commands.length, 0);
  }
});
test("saved agent references reuse each specialist's session after process reconstruction", async () => {
  const ref = {
    id: "hosted-power",
    turnId: "prior-turn",
    role: "Power & Thermal",
    model: "gpt-6-sol",
    missionId: "mission",
    results: new Map(),
  };
  let sent = 0;
  const api = {
    start: async () => {
      throw new Error("must not create another session");
    },
    send: async (current: typeof ref) => {
      assert.equal(current.id, ref.id);
      sent++;
      return { text: "continued" };
    },
  };
  const sessions = new MissionSessions("mission", api, [ref]);
  await sessions.run("Power & Thermal", { model: ref.model }, "Follow up", async () => null);
  assert.equal(sent, 1);
});
test("aggregate budgets reserve parallel consultations atomically and fail closed", () => {
  const budget = new InvestigationBudget({
    ...investigationLimits({}),
    consultations: 2,
    functionCalls: 2,
    validationRetries: 1,
  });
  try {
    budget.consult(2);
    assert.throws(() => budget.consult(1), /consultation limit/);
    assert.equal(budget.metrics.consultations, 2);
  } finally {
    budget.finish();
  }
  for (const metric of ["functionCall", "invalidProposal"] as const) {
    const limited = new InvestigationBudget({
      ...investigationLimits({}),
      functionCalls: 1,
      validationRetries: 1,
    });
    try {
      limited[metric]();
      assert.throws(() => limited[metric](), /limit reached/);
    } finally {
      limited.finish();
    }
  }
});
test("wall time aborts a stalled operation; observed mission token and cost totals stop follow-ups", async () => {
  const budget = new InvestigationBudget({ ...investigationLimits({}), milliseconds: 20 });
  // The budget timer is unreferenced; the stalled mock has no active I/O to keep Node alive.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(abortable(new Promise(() => {}), budget.controller.signal), /time limit/);
  } finally {
    clearInterval(keepAlive);
    budget.finish();
  }
  const sample = new MissionUsageCollector();
  sample.record(
    "turn",
    { input_tokens: 1000, output_tokens: 1000, total_tokens: 2000 },
    "gpt-6-astra"
  );
  for (const limits of [{ tokens: 100 }, { estimatedCostUsd: 0.01 }]) {
    const limited = new InvestigationBudget({ ...investigationLimits({}), ...limits }, () =>
      sample.summary()
    );
    try {
      assert.throws(() => limited.check(), /limit reached/);
    } finally {
      limited.finish();
    }
  }
});
test("validation feedback identifies the malformed field without disclosing a solution", () => {
  try {
    validateMissionPlan(createMission(), { headline: "", actions: [] });
    assert.fail("must reject");
  } catch (error) {
    const feedback = planValidationFeedback(error);
    assert.match(feedback, /headline/);
    assert.match(feedback, /actions/);
    assert.doesNotMatch(feedback, /recall_eva|isolate_scrubber/);
  }
});

test("separate browsers have isolated state, approvals and locks; refresh attaches to existing work", async () => {
  const disk = new DurableJson<MissionRecord>();
  const store = new MissionStore(disk);
  const pending = new Map<string, { id: string; plan: DecisionPlan }>();
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const started = new Promise<void>((r) => {
    entered = r;
  });
  let count = 0;
  const runtime: NonNullable<Parameters<typeof createMissionApp>[0]> = {
    clearMissionSession: async (id) => {
      pending.delete(id);
    },
    pendingMissionApproval: (id) => pending.get(id),
    resolveMissionApproval: async () => {
      throw new Error("not used");
    },
    runMissionDirector: async (state) => {
      count++;
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
      const plan = {
        headline: "Test",
        actions: [state.scenario.availableActions[0]],
        rationale: "Test",
        uncertainties: [],
        approvalScope: "Test",
      };
      const id = randomUUID();
      pending.set(state.missionId, { id, plan });
      return {
        log: [],
        reports: [],
        plan,
        proposalId: id,
        awaitingApproval: true,
        investigation: { elapsedMs: 0, consultations: 1, functionCalls: 1, validationRetries: 0 },
        usage: new MissionUsageCollector().summary(),
      };
    },
  };
  const server = createMissionApp(runtime, accessConfig({}), store).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  function client() {
    let cookie = "";
    return async (path = "/api/mission", body?: unknown) =>
      new Promise<{ status: number; data: Record<string, unknown> }>((resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path,
            method: body ? "POST" : "GET",
            headers: {
              Host: "localhost:3001",
              Origin: "http://localhost:5173",
              Cookie: cookie,
              "Content-Type": "application/json",
            },
          },
          (res) => {
            cookie = res.headers["set-cookie"]?.[0]?.split(";")[0] ?? cookie;
            let text = "";
            res.on("data", (chunk) => (text += chunk));
            res.on("end", () =>
              resolve({
                status: res.statusCode!,
                data: res.headers["content-type"]?.includes("json") ? JSON.parse(text) : {},
              })
            );
          }
        );
        req.on("error", reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
  }
  try {
    const alice = client(),
      bob = client();
    const a = (await alice()).data,
      b = (await bob()).data;
    assert.notEqual(a.missionId, b.missionId);
    const running = alice("/api/mission/convene", {});
    await started;
    assert.equal((await alice("/api/mission/reset", {})).status, 409);
    assert.equal((await bob("/api/mission/reset", {})).status, 200);
    assert.equal(((await alice()).data.operation as { status: string }).status, "running");
    assert.equal(count, 1);
    release();
    await running;
    const complete = (await alice()).data;
    assert.equal(
      (await bob("/api/mission/request-approval", { proposalId: complete.proposalId })).status,
      409
    );
    assert.equal(
      (await alice("/api/mission/request-approval", { proposalId: complete.proposalId })).status,
      200
    );
    assert.equal(count, 1);
  } finally {
    release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("pending API approval survives a real process restart and is consumed once", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const dir = mkdtempSync(join(tmpdir(), "ares-restart-"));
  try {
    const run = promisify(execFile);
    const first = await run(process.execPath, [
      "--import",
      "tsx",
      "evals/recovery-worker.ts",
      dir,
      "create",
    ]);
    assert.match(first.stdout, /saved/);
    const second = await run(process.execPath, [
      "--import",
      "tsx",
      "evals/recovery-worker.ts",
      dir,
      "restore",
    ]);
    assert.match(second.stdout, /restored-and-consumed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("known cost stops further work even while another turn's accounting is missing", () => {
  const usage = new MissionUsageCollector();
  usage.record(
    "expensive",
    { input_tokens: 250000, output_tokens: 0, total_tokens: 250000 },
    "gpt-6-astra"
  );
  usage.record("pending", null, "gpt-6-sol");
  assert.equal(usage.summary().estimatedCostUsd, undefined);
  const budget = new InvestigationBudget(investigationLimits({}), () => usage.summary());
  try {
    assert.throws(() => budget.check(), /cost limit/);
  } finally {
    budget.finish();
  }
});
