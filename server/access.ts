import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export function accessConfig(env: NodeJS.ProcessEnv = process.env) {
  const host = env.HOST?.trim() || "127.0.0.1";
  const port = Number(env.PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535.");
  const local = host === "127.0.0.1" || host === "::1";
  const password = env.MISSION_ACCESS_PASSWORD || "";

  const localOrigins = ["localhost", "127.0.0.1", "[::1]"].flatMap((name) =>
    [...new Set([port, 5173])].map((value) => new URL(`http://${name}:${value}`).origin)
  );
  const origins = env.MISSION_ALLOWED_ORIGINS?.trim()
    ? env.MISSION_ALLOWED_ORIGINS.split(",").map((origin) => origin.trim())
    : local
      ? localOrigins
      : [];
  if (!origins.length) throw new Error("Set MISSION_ALLOWED_ORIGINS for network access.");
  let requiresPassword = !local || Boolean(password);
  for (const origin of origins) {
    const url = new URL(origin);
    const remoteOrigin = !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    requiresPassword ||= remoteOrigin;
    if (
      url.origin !== origin ||
      !["http:", "https:"].includes(url.protocol) ||
      ((!local || remoteOrigin) && url.protocol !== "https:")
    )
      throw new Error("Allowed origins must be exact origins; network access requires HTTPS.");
  }
  if (requiresPassword && password.length < 12)
    throw new Error("MISSION_ACCESS_PASSWORD must contain at least 12 characters.");
  return { host, port, local, password, origins, localOrigins };
}

export function requireMissionAccess(config: ReturnType<typeof accessConfig>): RequestHandler {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(`commander:${config.password}`);
  const localHosts = new Set(
    config.localOrigins.flatMap((origin) => {
      const url = new URL(origin);
      return url.port ? [url.host] : [url.host, `${url.hostname}:80`];
    })
  );
  return (req, res, next) => {
    // Do not trust forwarded Host/Origin headers to grant access.
    if (config.local && !localHosts.has(req.headers.host?.toLowerCase() ?? "")) {
      res.status(403).json({ error: "Unrecognized local host." });
      return;
    }
    const origin = req.get("Origin");
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    if (
      (origin !== undefined && !config.origins.includes(origin)) ||
      (mutating && !origin) ||
      (mutating && req.get("Sec-Fetch-Site") === "cross-site")
    ) {
      res.status(403).json({ error: "Request origin is not allowed." });
      return;
    }
    if (config.password) {
      const authorization = req.get("Authorization") ?? "";
      const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
      const credentials = match ? Buffer.from(match[1], "base64").toString("utf8") : "";
      if (!timingSafeEqual(digest(credentials), expected)) {
        res.setHeader("WWW-Authenticate", 'Basic realm="Mission Control", charset="UTF-8"');
        res.setHeader("Cache-Control", "no-store");
        res.status(401).json({ error: "Sign in to Mission Control." });
        return;
      }
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  };
}
