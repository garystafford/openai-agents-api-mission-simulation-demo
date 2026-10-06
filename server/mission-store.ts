import { createHash, randomBytes } from "node:crypto";
import type { RequestHandler } from "express";
import { DurableJson } from "./durable-json.js";
import { createMission, randomScenarioId, type MissionState } from "./mission.js";

import type { ExecutionPlayback, MissionOperation } from "./mission-contract.js";
export type { MissionOperation } from "./mission-contract.js";

export type MissionRecord = {
  version: 1;
  state: MissionState;
  operation?: MissionOperation;
  execution?: ExecutionPlayback;
  updatedAt: number;
};
export const ownerKey = (token: string) => createHash("sha256").update(token).digest("hex");
const cookieName = "ares_commander";
export class MissionStore {
  private readonly records = new Map<string, MissionRecord>();
  constructor(private readonly disk = new DurableJson<MissionRecord>()) {}
  restoreAll() {
    for (const key of this.disk.keys()) this.load(key);
  }
  entries() {
    return this.records.entries();
  }
  exists(key: string) {
    return this.records.has(key) || this.disk.get(key) !== undefined;
  }
  load(key: string) {
    let record = this.records.get(key);
    if (record) return record;
    record = this.disk.get(key);
    if (record && (record.version !== 1 || !record.state?.missionId))
      throw new Error("Unsupported saved mission format.");
    if (record?.operation?.status === "running") {
      record.operation.status = "interrupted";
      record.operation.message =
        "The server restarted during this operation. No commands were replayed. Request a fresh assessment.";
      if (record.state.replanning) record.state.replanning.status = "interrupted";
      record.state.pendingCommand = undefined;
      record.state.proposalId = undefined;
      record.state.selectedPlan = undefined;
      if (record.state.phase !== "executing") record.state.phase = "assessment";
      else
        record.execution = {
          status: "paused",
          message:
            "Execution paused after an interrupted operation. Review conditions before resuming.",
        };
      this.save(key, record);
    }
    if (!record)
      record = { version: 1, state: createMission(randomScenarioId()), updatedAt: Date.now() };
    this.records.set(key, record);
    this.save(key, record);
    return record;
  }
  save(key: string, record: MissionRecord) {
    record.updatedAt = Date.now();
    this.disk.set(key, record);
    this.records.set(key, record);
  }
  middleware(secure: boolean): RequestHandler {
    return (req, res, next) => {
      const cookies = (req.get("Cookie") ?? "").split(";").map((part) => part.trim());
      const value = cookies
        .find((part) => part.startsWith(cookieName + "="))
        ?.slice(cookieName.length + 1);
      // An opaque bearer cookie identifies only this browser. Mission IDs never grant access.
      const token =
        value && /^[a-f0-9]{64}$/.test(value) && this.exists(ownerKey(value))
          ? value
          : randomBytes(32).toString("hex");
      const key = ownerKey(token);
      res.cookie(cookieName, token, {
        httpOnly: true,
        sameSite: "strict",
        secure,
        path: "/",
        maxAge: 30 * 24 * 3600 * 1000,
      });
      res.set("Cache-Control", "no-store");
      res.locals.owner = key;
      res.locals.missionRecord = this.load(key);
      next();
    };
  }
}
