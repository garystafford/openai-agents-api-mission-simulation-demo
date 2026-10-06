import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { createMissionApp } from "../server/app.js";
import { accessConfig } from "../server/access.js";
import { MissionUsageCollector } from "../server/mission-usage.js";
import type { DecisionPlan } from "../server/mission.js";

async function fixture() {
  let pending: { id: string; plan: DecisionPlan } | undefined;
  let release: (() => void) | undefined;
  let block = false;
  let decisions = 0;
  const assessments: import("../server/mission.js").MissionState[] = [];
  const runtime: NonNullable<Parameters<typeof createMissionApp>[0]> = {
    clearMissionSession: async () => {
      pending = undefined;
    },
    pendingMissionApproval: () => pending,
    runMissionDirector: async (state) => {
      assessments.push(structuredClone(state));
      pending = undefined;
      if (block)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      const plan: DecisionPlan = {
        headline: "Test plan",
        actions: ["verify_orbital_weather"],
        rationale: "Protect crew",
        uncertainties: [],
        approvalScope: "Approve selected actions",
      };
      pending = { id: randomUUID(), plan };
      return {
        log: [],
        reports: [],
        plan,
        proposalId: pending.id,
        awaitingApproval: true,
        usage: new MissionUsageCollector().summary(),
      };
    },
    resolveMissionApproval: async (state, _approved, id) => {
      assert.equal(id, pending?.id);
      assert.deepEqual(state.selectedPlan, pending?.plan);
      decisions++;
      pending = undefined;
      return { awaitingApproval: false, usage: new MissionUsageCollector().summary() } as Awaited<
        ReturnType<NonNullable<Parameters<typeof createMissionApp>[0]>["resolveMissionApproval"]>
      >;
    },
  };
  const server = createMissionApp(runtime, accessConfig({})).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  let cookie = "";
  const send = (path: string, body: unknown = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path,
          method: "POST",
          headers: {
            Cookie: cookie,
            Host: "localhost:3001",
            Origin: "http://localhost:5173",
            "Content-Type": "application/json",
          },
        },
        (res) => {
          cookie = res.headers["set-cookie"]?.[0]?.split(";")[0] ?? cookie;
          let text = "";
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode!, body: text }));
        }
      );
      req.on("error", reject);
      req.end(JSON.stringify(body));
    });
  return {
    send,
    assessments,
    pending: () => pending,
    decisions: () => decisions,
    hold: () => {
      block = true;
    },
    release: () => release?.(),
    waitUntilBlocked: async () => {
      while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("HTTP approval uses the server plan, rejects malformed decisions, and cannot be replayed", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send("/api/mission/convene")).status, 200);
    const pending = f.pending()!;
    assert.equal(
      (await f.send("/api/mission/approve", { approved: true, proposalId: pending.id })).status,
      409
    );
    const review = await f.send("/api/mission/request-approval", {
      proposalId: pending.id,
      plan: { actions: ["deploy_repair_drone"] },
    });
    assert.equal(review.status, 200);
    assert.deepEqual(JSON.parse(review.body).selectedPlan, pending.plan);
    assert.equal(
      (await f.send("/api/mission/approve", { approved: "false", proposalId: pending.id })).status,
      400
    );
    assert.equal(f.decisions(), 0);
    const approved = await f.send("/api/mission/approve", {
      approved: true,
      proposalId: pending.id,
    });
    assert.equal(approved.status, 200);
    assert.equal(JSON.parse(approved.body).phase, "executing");
    assert.equal(JSON.parse(approved.body).execution.status, "running");
    assert.equal((await f.send("/api/mission/advance")).status, 409);
    assert.equal((await f.send("/api/mission/playback", { paused: "yes" })).status, 400);
    const paused = await f.send("/api/mission/playback", { paused: true });
    assert.equal(JSON.parse(paused.body).execution.status, "paused");
    assert.equal((await f.send("/api/mission/advance")).status, 200);
    const resumed = await f.send("/api/mission/playback", { paused: false });
    assert.equal(JSON.parse(resumed.body).execution.status, "running");
    assert.equal(
      (await f.send("/api/mission/approve", { approved: true, proposalId: pending.id })).status,
      409
    );
    assert.equal(f.decisions(), 1);
    const reset = JSON.parse((await f.send("/api/mission/reset")).body);
    assert.equal(reset.phase, "alert");
    assert.equal(reset.execution, undefined);
  } finally {
    await f.close();
  }
});

test("reassessment invalidates stale proposal revisions and declining does not dispatch", async () => {
  const f = await fixture();
  try {
    await f.send("/api/mission/convene");
    const oldId = f.pending()!.id;
    await f.send("/api/mission/convene", { reviewRequest: "Verify crew safety." });
    const id = f.pending()!.id;
    assert.notEqual(id, oldId);
    assert.equal(
      (await f.send("/api/mission/request-approval", { proposalId: oldId })).status,
      409
    );
    await f.send("/api/mission/request-approval", { proposalId: id });
    const declined = await f.send("/api/mission/approve", { approved: false, proposalId: id });
    assert.equal(JSON.parse(declined.body).phase, "assessment");
    assert.equal(JSON.parse(declined.body).execution, undefined);
    assert.equal(JSON.parse(declined.body).pendingCommand, undefined);
    assert.equal(JSON.parse(declined.body).selectedPlan, undefined);
  } finally {
    await f.close();
  }
});

test("a pending assessment blocks resets, other assessments, and approvals", async () => {
  const f = await fixture();
  f.hold();
  const assessment = f.send("/api/mission/convene");
  try {
    await f.waitUntilBlocked();
    for (const path of ["reset", "convene", "approve", "request-approval", "advance", "playback"])
      assert.equal((await f.send("/api/mission/" + path)).status, 409);
  } finally {
    f.release();
    await assessment;
    await f.close();
  }
});

test("unsuccessful execution can be reassessed using changed conditions in the same mission", async () => {
  const f = await fixture();
  try {
    await f.send("/api/mission/convene");
    const id = f.pending()!.id;
    await f.send("/api/mission/request-approval", { proposalId: id });
    const approved = JSON.parse(
      (await f.send("/api/mission/approve", { approved: true, proposalId: id })).body
    );
    assert.equal(approved.outcome, undefined);
    await f.send("/api/mission/playback", { paused: true });
    let result = approved;
    for (let i = 0; i < 3; i++) result = JSON.parse((await f.send("/api/mission/advance")).body);
    assert.equal(result.outcome, "degraded");
    assert.equal(result.phase, "assessment");
    assert.equal(result.execution.status, "stopped");
    assert.equal((await f.send("/api/mission/playback", { paused: false })).status, 409);
    assert.notDeepEqual(result.simulation.conditions, f.assessments[0].simulation.conditions);
    assert.equal(
      (
        await f.send("/api/mission/convene", {
          reviewRequest: "Recover from the unsuccessful response.",
        })
      ).status,
      200
    );
    assert.equal(f.assessments[1].missionId, f.assessments[0].missionId);
    assert.deepEqual(f.assessments[1].simulation, result.simulation);
    assert.equal(f.assessments[1].outcome, "degraded");
  } finally {
    await f.close();
  }
});

test("incident configuration validates inputs and reproducible random selection", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send("/api/mission/reset", { profile: "unknown" })).status, 400);
    assert.equal((await f.send("/api/mission/reset", { seed: "" })).status, 400);
    const first = JSON.parse(
      (await f.send("/api/mission/reset", { seed: "configured", profile: "varied" })).body
    );
    const second = JSON.parse(
      (await f.send("/api/mission/reset", { seed: "configured", profile: "varied" })).body
    );
    assert.equal(first.scenario.id, second.scenario.id);
    assert.deepEqual(first.simulation, second.simulation);
    assert.equal(second.variation.seed, "configured");
  } finally {
    await f.close();
  }
});
