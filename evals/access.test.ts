import assert from "node:assert/strict";
import { request } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { accessConfig, requireMissionAccess } from "../server/access.js";

const password = "test-only-password-not-a-secret-1234567890";
const authorization = "Basic " + Buffer.from(`commander:${password}`).toString("base64");
const remote = {
  HOST: "0.0.0.0",
  MISSION_ACCESS_PASSWORD: password,
  MISSION_ALLOWED_ORIGINS: "https://mission.example.com",
};

async function fixture(env: NodeJS.ProcessEnv = {}) {
  const app = express();
  let operations = 0;
  app.use(requireMissionAccess(accessConfig(env)));
  app.use(express.json());
  app.get(["/", "/health", "/api/mission"], (_req, res) => res.json({ ok: true }));
  app.post("/api/mission/:operation", (req, res) => {
    operations++;
    if (req.params.operation === "convene") {
      res.type("text/event-stream").end('data: {"type":"complete"}\n\n');
    } else res.json({ ok: true });
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    operations: () => operations,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    send: (method: string, path: string, headers: Record<string, string> = {}, body?: string) =>
      new Promise<{ status: number; body: string; headers: Record<string, unknown> }>(
        (resolve, reject) => {
          const req = request(
            {
              hostname: "127.0.0.1",
              port: address.port,
              path,
              method,
              headers: { Host: "localhost:3001", ...headers },
            },
            (res) => {
              let result = "";
              res.setEncoding("utf8");
              res.on("data", (chunk) => (result += chunk));
              res.on("end", () =>
                resolve({ status: res.statusCode!, body: result, headers: res.headers })
              );
            }
          );
          req.on("error", reject);
          req.end(body);
        }
      ),
  };
}

test("local default and explicit deployment configuration", () => {
  assert.equal(accessConfig({}).host, "127.0.0.1");
  assert.equal(accessConfig({}).port, 3001);
  assert(accessConfig({ PORT: "80" }).origins.includes("http://localhost"));
  assert.equal(accessConfig({ HOST: "::1", PORT: "4001" }).local, true);
  assert.equal(accessConfig(remote).local, false);
  for (const env of [
    { HOST: "0.0.0.0" },
    { HOST: "localhost" },
    { MISSION_ALLOWED_ORIGINS: "https://mission.example.com" },
    { MISSION_ACCESS_PASSWORD: password, MISSION_ALLOWED_ORIGINS: "http://mission.example.com" },
    { ...remote, MISSION_ACCESS_PASSWORD: "short" },
    { ...remote, MISSION_ALLOWED_ORIGINS: "" },
    { ...remote, MISSION_ALLOWED_ORIGINS: "http://mission.example.com" },
    { ...remote, MISSION_ALLOWED_ORIGINS: "https://mission.example.com/path" },
    { ...remote, MISSION_ALLOWED_ORIGINS: "https://user:password@mission.example.com" },
    { ...remote, MISSION_ALLOWED_ORIGINS: "null" },
    { PORT: "0" },
    { PORT: "invalid" },
  ])
    assert.throws(() => accessConfig(env));
  assert.equal(accessConfig({ ...remote, HOST: "127.0.0.1" }).password, password);
});

test("access passwords require at least 12 characters locally and remotely", () => {
  for (const env of [{}, remote]) {
    assert.throws(
      () => accessConfig({ ...env, MISSION_ACCESS_PASSWORD: "a".repeat(11) }),
      /at least 12 characters/
    );
    const password = "a".repeat(12);
    assert.equal(accessConfig({ ...env, MISSION_ACCESS_PASSWORD: password }).password, password);
  }
});

test("local bodyless and JSON requests work through Vite and production origins", async () => {
  const f = await fixture();
  try {
    for (const origin of accessConfig({}).origins) {
      const result = await f.send("POST", "/api/mission/convene", {
        Origin: origin,
        Host: new URL(origin).host,
      });
      assert.equal(result.status, 200);
      assert.match(result.body, /data: /);
    }
    assert.equal(
      (
        await f.send(
          "POST",
          "/api/mission/approve",
          {
            Origin: "http://localhost:5173",
            "Content-Type": "application/json",
          },
          '{"approved":false}'
        )
      ).status,
      200
    );
    assert.equal((await f.send("GET", "/api/mission")).status, 200);
  } finally {
    await f.close();
  }
});

test("browser origin and DNS rebinding attempts cannot reach local operations", async () => {
  const f = await fixture();
  try {
    for (const headers of [
      {},
      { Origin: "null" },
      { Origin: "https://evil.example" },
      { Origin: "http://localhost:5173.evil.example" },
      { Origin: "http://localhost:5173", Host: "evil.example:3001" },
      { Origin: "http://localhost:5173", "Sec-Fetch-Site": "cross-site" },
      { "X-Forwarded-Host": "localhost:3001", "X-Forwarded-Origin": "http://localhost:5173" },
    ]) {
      assert.equal((await f.send("POST", "/api/mission/convene", headers)).status, 403);
    }
    assert.equal((await f.send("GET", "/api/mission", { Host: "evil.example:3001" })).status, 403);
    assert.equal(f.operations(), 0);
  } finally {
    await f.close();
  }
});

test("remote auth protects every route before parsing or paid work", async () => {
  const f = await fixture(remote);
  try {
    for (const route of [
      "convene",
      "approve",
      "reset",
      "advance",
      "request-approval",
      "playback",
    ]) {
      for (const auth of [
        "",
        "Bearer anything",
        "Basic !!!",
        "Basic " + Buffer.from("commander:wrong").toString("base64"),
      ]) {
        const result = await f.send(
          "POST",
          `/api/mission/${route}`,
          {
            Origin: remote.MISSION_ALLOWED_ORIGINS,
            Authorization: auth,
            "Content-Type": "application/json",
          },
          "invalid json"
        );
        assert.equal(result.status, 401);
        assert.match(String(result.headers["www-authenticate"]), /^Basic /);
      }
    }
    for (const route of ["/", "/health", "/api/mission"])
      assert.equal((await f.send("GET", route)).status, 401);
    assert.equal(f.operations(), 0);
  } finally {
    await f.close();
  }
});

test("signed-in deployment supports SSE and JSON without CORS", async () => {
  const f = await fixture(remote);
  const headers = { Authorization: authorization, Origin: remote.MISSION_ALLOWED_ORIGINS };
  try {
    assert.equal(
      (await f.send("GET", "/", { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" }))
        .status,
      401
    );
    assert.equal(
      (
        await f.send("GET", "/", {
          Authorization: authorization,
          "Sec-Fetch-Site": "cross-site",
          "Sec-Fetch-Mode": "navigate",
        })
      ).status,
      200
    );
    assert.equal((await f.send("GET", "/", headers)).status, 200);
    const stream = await f.send("POST", "/api/mission/convene", headers);
    assert.equal(stream.status, 200);
    assert.match(String(stream.headers["content-type"]), /text\/event-stream/);
    assert.match(stream.body, /complete/);
    assert.equal(stream.headers["access-control-allow-origin"], undefined);
    assert.equal(
      (
        await f.send(
          "POST",
          "/api/mission/approve",
          {
            ...headers,
            "Content-Type": "application/json",
          },
          '{"approved":true}'
        )
      ).status,
      200
    );
    assert.equal(
      (
        await f.send("POST", "/api/mission/approve", {
          ...headers,
          Origin: "https://evil.example",
        })
      ).status,
      403
    );
    assert.equal(
      (
        await f.send("POST", "/api/mission/convene", {
          Authorization: authorization,
        })
      ).status,
      403
    );
    assert.equal(f.operations(), 2);
  } finally {
    await f.close();
  }
});

test("default HTTP port and explicit :80 Host representations remain usable", async () => {
  const f = await fixture({ PORT: "80" });
  try {
    for (const host of ["localhost", "localhost:80", "LOCALHOST:80", "127.0.0.1:80", "[::1]:80"]) {
      assert.equal(
        (
          await f.send("POST", "/api/mission/reset", {
            Host: host,
            Origin: "http://localhost",
          })
        ).status,
        200
      );
    }
  } finally {
    await f.close();
  }
});
