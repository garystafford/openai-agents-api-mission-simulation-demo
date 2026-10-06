import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  createMission,
  requestCommand,
  approveCommand,
  advanceMission,
} from "../server/mission.js";
import { MissionAssessment, type MissionRuntime } from "../server/mission-assessment.js";
import { MissionStore, ownerKey } from "../server/mission-store.js";
import { DurableJson } from "../server/durable-json.js";
import { MissionUsageCollector } from "../server/mission-usage.js";
import { testPlan } from "./fixtures.js";

const failedResponse = () =>
  advanceMission(
    approveCommand(
      requestCommand(
        createMission("coolant_leak", { seed: "retry", profile: "repair_failure" }),
        testPlan(["deploy_repair_drone", "shed_nonessential_load"])
      ),
      true
    ),
    4
  );

test("an action failure stops the response at its event second and preserves changed conditions", () => {
  const state = failedResponse();
  assert.equal(state.simulation.elapsedMinutes, 1);
  assert.equal(state.phase, "assessment");
  assert.equal(state.replanning?.status, "queued");
  assert(state.simulation.commands.every((command) => command.status === "failed"));
  assert(state.simulation.conditions.coolantPct < 42);
  assert.equal(state.pendingCommand, undefined);
});

test("automatic replanning is single flight, bounded, and cannot dispatch without human approval", async () => {
  const store = new MissionStore();
  const locks = new Set<string>();
  const key = ownerKey("replan");
  const record = store.load(key);
  record.state = failedResponse();
  store.save(key, record);
  let calls = 0;
  let decisions = 0;
  let release!: () => void;
  const runtime = {
    runMissionDirector: async (state: typeof record.state) => {
      calls++;
      assert.equal(state.simulation.elapsedMinutes, 1);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        log: [],
        reports: [],
        plan: testPlan(["deploy_repair_drone", "shed_nonessential_load"]),
        proposalId: randomUUID(),
        usage: new MissionUsageCollector().summary(),
        awaitingApproval: true,
      };
    },
    resolveMissionApproval: async () => {
      decisions++;
    },
  } as unknown as MissionRuntime;
  const coordinator = new MissionAssessment(store, locks, runtime);
  coordinator.tick();
  coordinator.tick();
  assert.equal(calls, 1);
  assert(locks.has(key));
  release();
  for (let i = 0; i < 20 && store.load(key).operation?.status === "running"; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(store.load(key).state.replanning?.status, "ready");
  assert.equal(store.load(key).state.phase, "assessment");
  assert(store.load(key).state.proposalId);
  assert.equal(store.load(key).state.pendingCommand, undefined);
  assert.equal(store.load(key).state.simulation.elapsedMinutes, 1);
  assert.equal(decisions, 0);
  const capped = store.load(key);
  capped.state.replanning = { attempts: 2, status: "queued", reason: "Another failure" };
  store.save(key, capped);
  coordinator.tick();
  assert.equal(calls, 1);
  assert.equal(store.load(key).state.replanning?.status, "limit");
});

test("queued replanning survives restart, while an interrupted assessment is never replayed", async () => {
  const disk = new DurableJson<import("../server/mission-store.js").MissionRecord>();
  const store = new MissionStore(disk);
  const key = ownerKey("restart-replan");
  const record = store.load(key);
  record.state = failedResponse();
  store.save(key, record);
  const restored = new MissionStore(disk);
  restored.restoreAll();
  assert.equal(restored.load(key).state.replanning?.status, "queued");
  const running = restored.load(key);
  running.state.replanning!.status = "running";
  running.state.replanning!.attempts = 1;
  running.operation = { kind: "assessment", status: "running", startedAt: Date.now() };
  restored.save(key, running);
  const interrupted = new MissionStore(disk).load(key);
  assert.equal(interrupted.state.replanning?.status, "interrupted");
  assert.equal(interrupted.operation?.status, "interrupted");
  assert.equal(interrupted.state.proposalId, undefined);
});

test("terminal safety failures never queue model work", () => {
  const state = createMission();
  state.minutesToImpact = 1 / 60;
  const result = advanceMission(
    approveCommand(requestCommand(state, testPlan(["recall_eva"])), true),
    1
  );
  assert.equal(result.phase, "failed");
  assert.equal(result.replanning, undefined);
});
