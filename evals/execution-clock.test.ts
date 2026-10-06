import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionClock } from "../server/execution-clock.js";
import { DurableJson } from "../server/durable-json.js";
import { MissionStore, ownerKey, type MissionRecord } from "../server/mission-store.js";
import {
  approveCommand,
  createMission,
  requestCommand,
  type MissionState,
} from "../server/mission.js";
import { testPlan } from "./fixtures.js";

function fixture(disk = new DurableJson<MissionRecord>()) {
  let time = 1000;
  const store = new MissionStore(disk);
  const locks = new Set<string>();
  const clock = new ExecutionClock(store, locks, () => time);
  const key = ownerKey("commander");
  const dispatch = (state = createMission(), id = key) => {
    const record = store.load(id);
    record.state = approveCommand(
      requestCommand(state, testPlan(["verify_orbital_weather"])),
      true
    );
    record.execution = clock.begin();
    store.save(id, record);
  };
  return {
    store,
    locks,
    clock,
    key,
    dispatch,
    now: () => time,
    elapse: (ms: number) => {
      time += ms;
    },
  };
}

test("server clock waits for authorization and deadlines, without catching up missed ticks", () => {
  const f = fixture();
  f.store.load(f.key);
  f.elapse(60_000);
  f.clock.tick();
  assert.equal(f.store.load(f.key).state.simulation.elapsedMinutes, 0);
  f.dispatch();
  f.elapse(999);
  f.clock.tick();
  assert.equal(f.store.load(f.key).state.simulation.elapsedMinutes, 0);
  f.elapse(1);
  f.clock.tick();
  assert.equal(f.store.load(f.key).state.simulation.elapsedMinutes, 0.8);
  f.elapse(60_000);
  f.clock.tick();
  f.clock.tick();
  assert.equal(f.store.load(f.key).state.simulation.elapsedMinutes, 1.6);
});

test("pause freezes conditions; resume preserves the remaining delay and is idempotent", () => {
  const f = fixture();
  f.dispatch();
  f.elapse(400);
  const paused = f.clock.playback(f.key, true);
  assert.equal(paused.execution?.remainingMs, 600);
  f.elapse(30_000);
  f.clock.tick();
  assert.deepEqual(f.store.load(f.key).state, paused.state);
  f.clock.playback(f.key, true);
  const resumed = f.clock.playback(f.key, false);
  f.elapse(400);
  assert.equal(f.clock.playback(f.key, false).execution?.nextTickAt, resumed.execution?.nextTickAt);
  f.clock.tick();
  assert.equal(f.store.load(f.key).state.simulation.elapsedMinutes, 0);
  f.elapse(200);
  f.clock.tick();
  assert.equal(f.store.load(f.key).state.simulation.elapsedMinutes, 0.8);
});

test("manual stepping requires pause and does not restart automatic playback", () => {
  const f = fixture();
  f.dispatch();
  assert.throws(() => f.clock.step(f.key), /Pause/);
  f.clock.playback(f.key, true);
  const result = f.clock.step(f.key);
  assert.equal(result.state.simulation.elapsedMinutes, 4);
  assert.equal(result.execution?.status, "paused");
  f.elapse(60_000);
  f.clock.tick();
  assert.equal(f.store.load(f.key).state.simulation.elapsedMinutes, 4);
});

test("per-browser clocks advance independently and honor operation locks", () => {
  const f = fixture();
  const other = ownerKey("other browser");
  f.dispatch();
  f.elapse(2000);
  f.dispatch(createMission(), other);
  f.locks.add(f.key);
  f.elapse(5000);
  f.clock.tick();
  assert.equal(f.store.load(f.key).state.simulation.elapsedMinutes, 0);
  assert.equal(f.store.load(other).state.simulation.elapsedMinutes, 0.8);
  f.locks.delete(f.key);
  f.clock.tick();
  assert.equal(f.store.load(f.key).state.simulation.elapsedMinutes, 0.8);
  assert.equal(f.store.load(other).state.simulation.elapsedMinutes, 0.8);
});

test("success, failure and recoverable outcomes all stop playback without dispatching another plan", () => {
  const terminal = createMission("rover_recovery");
  terminal.simulation.conditions.batteryPct = 0.1;
  const candidates: Array<[MissionState, "assessment" | "resolved" | "failed"]> = [
    [
      approveCommand(requestCommand(createMission(), testPlan(["verify_orbital_weather"])), true),
      "assessment",
    ],
    [
      approveCommand(
        requestCommand(
          createMission("coolant_leak"),
          testPlan(["deploy_repair_drone", "shed_nonessential_load"])
        ),
        true
      ),
      "resolved",
    ],
    [approveCommand(requestCommand(terminal, testPlan(["deploy_repair_drone"])), true), "failed"],
  ];
  for (const [state, expected] of candidates) {
    const f = fixture();
    const record = f.store.load(f.key);
    record.state = state;
    record.execution = f.clock.begin();
    f.store.save(f.key, record);
    for (let i = 0; i < 60 && f.store.load(f.key).state.phase === "executing"; i++) {
      f.elapse(5000);
      f.clock.tick();
    }
    const stopped = structuredClone(f.store.load(f.key));
    assert.equal(stopped.state.phase, expected);
    assert.equal(stopped.execution?.status, "stopped");
    f.elapse(60_000);
    f.clock.tick();
    assert.deepEqual(f.store.load(f.key), stopped);
    assert.throws(() => f.clock.playback(f.key, false), /only while/);
  }
});

test("durable restart restores background execution without requests or offline advancement", () => {
  const directory = mkdtempSync(join(tmpdir(), "ares-clock-"));
  try {
    const f = fixture(new DurableJson(directory));
    f.dispatch();
    f.elapse(400);
    f.clock.stop();
    const restored = new MissionStore(new DurableJson<MissionRecord>(directory));
    let time = f.now() + 3_600_000;
    const clock = new ExecutionClock(restored, new Set(), () => time);
    // Constructor discovers the mission from disk before any browser has reconnected.
    assert.equal([...restored.entries()].length, 1);
    clock.tick();
    assert.equal(restored.load(f.key).state.simulation.elapsedMinutes, 0);
    assert.equal(restored.load(f.key).execution?.nextTickAt, time + 600);
    time += 600;
    clock.tick();
    assert.equal(restored.load(f.key).state.simulation.elapsedMinutes, 0.8);
    // An abrupt crash has no saved remaining delay: restart grants a fresh interval.
    time += 3_600_000;
    const afterCrash = new MissionStore(new DurableJson<MissionRecord>(directory));
    new ExecutionClock(afterCrash, new Set(), () => time).tick();
    assert.equal(afterCrash.load(f.key).state.simulation.elapsedMinutes, 0.8);
    assert.equal(afterCrash.load(f.key).execution?.nextTickAt, time + 1000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("paused and legacy executions stay paused after restart; interrupted operations cannot auto-resume", () => {
  for (const variant of ["paused", "legacy", "previous_timing", "interrupted"] as const) {
    const disk = new DurableJson<MissionRecord>();
    const f = fixture(disk);
    f.dispatch();
    const record = f.store.load(f.key);
    if (variant === "paused") f.clock.playback(f.key, true);
    else {
      if (variant === "legacy") record.execution = undefined;
      else if (variant === "previous_timing") record.execution!.timingVersion = 1;
      else record.operation = { kind: "reset", status: "running", startedAt: f.now() };
      f.store.save(f.key, record);
    }
    const restored = new MissionStore(disk);
    const clock = new ExecutionClock(restored, new Set(), () => 1_000_000);
    clock.tick();
    assert.equal(restored.load(f.key).execution?.status, "paused");
    assert.equal(restored.load(f.key).state.simulation.elapsedMinutes, 0);
  }
});

test("storage failure pauses execution and preserves the last saved physical conditions", () => {
  class FailingDisk extends DurableJson<MissionRecord> {
    failed = false;
    override set(key: string, value: MissionRecord) {
      if (this.failed) throw new Error("disk unavailable");
      super.set(key, value);
    }
  }
  const disk = new FailingDisk();
  const f = fixture(disk);
  f.dispatch();
  const before = structuredClone(f.store.load(f.key).state);
  disk.failed = true;
  f.elapse(5000);
  f.clock.tick();
  assert.deepEqual(f.store.load(f.key).state, before);
  assert.equal(f.store.load(f.key).execution?.status, "paused");
  assert.match(f.store.load(f.key).execution!.message!, /could not be saved/);
  disk.failed = false;
  f.clock.playback(f.key, false);
  f.elapse(5000);
  f.clock.tick();
  assert.equal(f.store.load(f.key).state.simulation.elapsedMinutes, 0.8);
});

test("the background timer advances an approved mission without a browser request", async () => {
  const f = fixture();
  f.dispatch();
  f.clock.start();
  try {
    f.elapse(5000);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(f.store.load(f.key).state.simulation.elapsedMinutes, 0.8);
  } finally {
    f.clock.stop();
  }
});

test("legacy rover executions retain physical progress but gain explicit recall and crew-arrival goals", () => {
  const disk = new DurableJson<MissionRecord>();
  const f = fixture(disk);
  const state = createMission("rover_recovery");
  state.scenario.availableActions = state.scenario.availableActions.filter(
    (a) => a !== "recall_eva"
  );
  state.scenario.objectives = state.scenario.objectives.filter(
    (g) => !["crewOutside", "distanceToSafetyKm"].includes(g.metric)
  );
  f.dispatch(state);
  const record = f.store.load(f.key);
  record.execution!.timingVersion = 3;
  record.state.recoveryStableSinceMinutes = 0;
  f.store.save(f.key, record);
  const restored = new MissionStore(disk);
  const clock = new ExecutionClock(restored, new Set(), () => 1_000_000);
  clock.tick();
  const current = restored.load(f.key);
  assert.equal(current.execution?.status, "paused");
  assert.deepEqual(current.state.simulation.conditions, state.simulation.conditions);
  assert(current.state.scenario.availableActions.includes("recall_eva"));
  assert(current.state.objectiveResults.some((g) => g.metric === "crewOutside" && !g.met));
  assert(current.state.objectiveResults.some((g) => g.metric === "distanceToSafetyKm" && !g.met));
  assert.equal(current.state.recoveryStableSinceMinutes, undefined);
});
