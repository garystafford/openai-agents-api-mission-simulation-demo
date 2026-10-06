import { seededChoice, variationProfiles } from "./incident-variation.js";
import express from "express";
import {
  executionTimingVersion,
  type AssessmentEvent,
  type MissionResponse,
} from "./mission-contract.js";
import { MissionAssessment, errorMessage } from "./mission-assessment.js";
import type { MissionRuntime } from "./mission-assessment.js";
import { ExecutionClock } from "./execution-clock.js";
import { MissionStore, type MissionRecord } from "./mission-store.js";
import { z } from "zod";
import { publicAgentProfiles } from "./agent-profiles.js";
import { accessConfig, requireMissionAccess } from "./access.js";
import { phoenixTracingEnabled } from "./instrumentation.js";
import * as missionAgents from "./agents.js";
import { approveCommand, createMission, randomScenarioId, requestCommand } from "./mission.js";

const proposalSchema = z.object({ proposalId: z.string().uuid() });
const approvalSchema = proposalSchema.extend({ approved: z.boolean() });
const reviewSchema = z.object({ reviewRequest: z.string().trim().min(1).max(4000).optional() });

export function createMissionApp(
  runtime: MissionRuntime = missionAgents,
  access = accessConfig(),
  store = new MissionStore()
) {
  const app = express();
  app.use(requireMissionAccess(access));
  app.use(express.json({ limit: "16kb" }));
  app.use(
    "/api",
    store.middleware(!access.local || access.origins.some((origin) => origin.startsWith("https:")))
  );
  const locks = new Set<string>();
  const clock = new ExecutionClock(store, locks);
  app.locals.executionClock = clock;
  const assessment = new MissionAssessment(store, locks, runtime);
  app.locals.missionAssessment = assessment;
  const missionResponse = (record: MissionRecord): MissionResponse => ({
    ...record.state,
    operation: record.operation,
    execution: record.execution,
    agentProfiles: publicAgentProfiles,
  });
  const available: express.RequestHandler = (_req, res, next) => {
    if (locks.has(res.locals.owner)) {
      res.status(409).json({ error: "A mission operation is in progress. Wait for it to finish." });
      return;
    }
    next();
  };
  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      runtime: "agents-api",
      phoenixTracing: phoenixTracingEnabled,
    })
  );
  app.get("/api/mission", (_req, res) => res.json(missionResponse(res.locals.missionRecord)));
  app.get("/api/mission/record", (_req, res) => {
    const state = (res.locals.missionRecord as MissionRecord).state;
    res.attachment("ares-mission-record.json").json({
      missionId: state.missionId,
      incident: state.scenario.title,
      scenarioId: state.scenario.id,
      simulatorVersion: executionTimingVersion,
      outcome: state.outcome,
      variation: state.variation,
      events: state.timeline,
    });
  });

  app.post("/api/mission/reset", available, async (req, res) => {
    const parsed = z
      .object({
        scenarioId: z
          .enum(["dust_storm", "coolant_leak", "relay_failure", "solar_flare", "rover_recovery"])
          .optional(),
        seed: z.string().trim().min(1).max(80).optional(),
        profile: z.enum(variationProfiles).optional(),
      })
      .strict()
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "Choose a valid incident, variation profile, and seed (1–80 characters)." });
      return;
    }
    const key = res.locals.owner as string;
    const record = res.locals.missionRecord as MissionRecord;
    let mission = record.state;
    record.operation = { kind: "reset", status: "running", startedAt: Date.now() };
    store.save(key, record);
    locks.add(key);
    try {
      await runtime.clearMissionSession(mission.missionId);
      mission = createMission(
        parsed.data.scenarioId ??
          (parsed.data.seed
            ? seededChoice(parsed.data.seed, [
                "dust_storm",
                "coolant_leak",
                "relay_failure",
                "solar_flare",
                "rover_recovery",
              ] as const)
            : randomScenarioId(mission.scenario.id)),
        {
          seed: parsed.data.seed ?? crypto.randomUUID(),
          profile: parsed.data.profile ?? "baseline",
        }
      );
      record.execution = undefined;
      record.state = mission;
      record.operation = { ...record.operation!, status: "complete" };
      store.save(key, record);
      res.json(missionResponse(record));
    } catch (error) {
      record.state = mission;
      record.operation = { ...record.operation!, status: "error", message: errorMessage(error) };
      store.save(key, record);
      res.status(502).json({ error: errorMessage(error) });
    } finally {
      locks.delete(key);
    }
  });

  app.post("/api/mission/request-approval", available, (req, res) => {
    const key = res.locals.owner as string;
    const record = res.locals.missionRecord as MissionRecord;
    let mission = record.state;
    const body = proposalSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "A valid proposalId is required." });
      return;
    }
    const pending = runtime.pendingMissionApproval(mission.missionId);
    if (!pending || pending.id !== body.data.proposalId || mission.proposalId !== pending.id) {
      res
        .status(409)
        .json({ error: "This proposal is no longer current. Request a new mission assessment." });
      return;
    }
    // Only the immutable API tool proposal is eligible for authorization.
    mission = requestCommand(mission, pending.plan);
    record.state = mission;
    store.save(key, record);
    res.json(missionResponse(record));
  });

  app.post("/api/mission/approve", available, async (req, res) => {
    const key = res.locals.owner as string;
    const record = res.locals.missionRecord as MissionRecord;
    let mission = record.state;
    const body = approvalSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "approved must be a boolean and proposalId must be valid." });
      return;
    }
    if (
      !mission.pendingCommand ||
      body.data.proposalId !== mission.proposalId ||
      runtime.pendingMissionApproval(mission.missionId)?.id !== mission.proposalId
    ) {
      res.status(409).json({ error: "Review the current mission proposal before authorizing it." });
      return;
    }
    locks.add(key);
    record.operation = { kind: "approval", status: "running", startedAt: Date.now() };
    store.save(key, record);
    try {
      const completion = await runtime.resolveMissionApproval(
        mission,
        body.data.approved,
        body.data.proposalId
      );
      mission = {
        ...approveCommand(mission, body.data.approved),
        selectedPlan: body.data.approved ? mission.selectedPlan : undefined,
        usage: completion.usage,
        proposalId: undefined,
      };
      record.state = mission;
      record.operation = { ...record.operation!, status: "complete" };
      record.execution = body.data.approved ? clock.begin() : undefined;
      store.save(key, record);
      res.json(missionResponse(record));
    } catch (error) {
      record.execution = undefined;
      mission = {
        ...mission,
        pendingCommand: undefined,
        proposalId: undefined,
        selectedPlan: undefined,
        phase: "assessment",
      };
      record.state = mission;
      record.operation = { ...record.operation!, status: "error", message: errorMessage(error) };
      store.save(key, record);
      res.status(502).json({ error: errorMessage(error) });
    } finally {
      locks.delete(key);
    }
  });

  app.post("/api/mission/playback", available, (req, res) => {
    const body = z.object({ paused: z.boolean() }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "paused must be a boolean." });
      return;
    }
    if (res.locals.missionRecord.state.phase !== "executing") {
      res
        .status(409)
        .json({ error: "Playback controls are available only while a plan is executing." });
      return;
    }
    res.json(missionResponse(clock.playback(res.locals.owner, body.data.paused)));
  });

  app.post("/api/mission/advance", available, (_req, res) => {
    const record = res.locals.missionRecord as MissionRecord;
    if (record.state.phase !== "executing" || record.execution?.status !== "paused") {
      res.status(409).json({ error: "Pause accelerated simulation before stepping manually." });
      return;
    }
    res.json(missionResponse(clock.step(res.locals.owner)));
  });

  app.post("/api/mission/convene", available, async (req, res) => {
    const key = res.locals.owner as string;
    const record = res.locals.missionRecord as MissionRecord;
    const mission = record.state;
    const body = reviewSchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "A review request must contain 1–4000 characters." });
      return;
    }
    if (
      mission.phase === "executing" ||
      mission.phase === "resolved" ||
      mission.phase === "failed"
    ) {
      res.status(409).json({ error: "Start a new incident before requesting another assessment." });
      return;
    }
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    const send = (payload: AssessmentEvent) => {
      if (!res.destroyed) res.write("data: " + JSON.stringify(payload) + "\n\n");
    };
    const keepalive = setInterval(() => {
      if (!res.destroyed) res.write(": mission in progress\n\n");
    }, 15000);
    try {
      await assessment.run(key, body.data.reviewRequest, (event) => {
        if (event.type === "complete") send({ ...event, state: missionResponse(store.load(key)) });
        else send(event);
      });
    } catch (error) {
      send({ type: "error", message: errorMessage(error) });
    } finally {
      clearInterval(keepalive);
      res.end();
    }
  });
  return app;
}
