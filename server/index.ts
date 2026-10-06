import type { MissionAssessment } from "./mission-assessment.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { accessConfig } from "./access.js";
import { createMissionApp } from "./app.js";
import { configureAgentStorage, suspendMissionSessions } from "./agents.js";
import type { ExecutionClock } from "./execution-clock.js";
import { DurableJson } from "./durable-json.js";
import { MissionStore, type MissionRecord } from "./mission-store.js";

const access = accessConfig();
const dataDirectory = path.resolve(process.env.MISSION_DATA_DIR || ".mission-data");
configureAgentStorage(path.join(dataDirectory, "agents"));
const app = createMissionApp(
  undefined,
  access,
  new MissionStore(new DurableJson<MissionRecord>(path.join(dataDirectory, "missions")))
);
const clock = app.locals.executionClock as ExecutionClock;
clock.start();
const assessment = app.locals.missionAssessment as MissionAssessment;
assessment.start();
const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
app.use(express.static(clientDir));
app.get("/{*splat}", (_req, res) => res.sendFile(path.join(clientDir, "index.html")));
const server = app.listen(access.port, access.host, () =>
  console.log(`Mission Control API listening on ${access.host}:${access.port}`)
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    assessment.stop();
    server.close();
    const force = setTimeout(() => process.exit(1), 10000);
    force.unref();
    void Promise.all([Promise.resolve().then(() => clock.stop()), suspendMissionSessions()])
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(String(error));
        process.exit(1);
      });
  });
}
