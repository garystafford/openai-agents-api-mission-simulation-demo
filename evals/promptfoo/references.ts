import "../../server/env.js";
import OpenAI from "openai";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { AgentsApi, toolError, toolResult, type SessionRef } from "../../server/agents-api.js";
import { MissionUsageCollector, pricingPerMillion } from "../../server/mission-usage.js";
import { InvestigationBudget, investigationLimits } from "../../server/investigation-budget.js";
import { connectMissionMcp } from "../../server/mission-evidence.js";
import { parseArguments } from "../../server/agent-schemas.js";
import { loadCase, loadManifest, directory, type ReviewedCase } from "./dataset.js";
import { replayContext } from "./replay.js";
import { directorToolHandler, type ReplayResult } from "./provider.js";
import { gradeEpisode } from "./assertions.js";

export const referenceModel = "gpt-6.1-sol";
export const referenceEffort = "high";
export const referencePricing = { input: 2, cachedInput: 0.1, output: 10 };
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function referenceRequest(item: ReviewedCase) {
  const replay = replayContext(item);
  // Deliberately allowlist the request. Never send the case's answer, review,
  // oracle, acceptable plans, future state or other teacher outputs to the model.
  return {
    agent: {
      ...replay.agent,
      model: referenceModel,
      reasoning: { effort: referenceEffort } as const,
      service_tier: "default" as const,
    },
    input: replay.input,
    fixedReports: item.record.role === "Mission Director" ? item.fixedReports : undefined,
  };
}
export type ReferenceRecord = {
  caseId: string;
  caseSha256: string;
  datasetSha256: string;
  role: string;
  model: string;
  effort: string;
  startedAt: string;
  elapsedMs: number;
  request: ReturnType<typeof referenceRequest>;
  sessionId?: string;
  turnId?: string;
  episode?: ReplayResult;
  error?: string;
  usage: ReturnType<MissionUsageCollector["summary"]>;
  usageError?: string;
  cleanup: { sessionDeleted: boolean; mcpClosed: boolean; errors: string[] };
  structuralCheck?: ReturnType<typeof gradeEpisode>;
};
export function assertReferenceLive(args: string[]) {
  if (!args.includes("--live"))
    throw new Error(
      "Reference generation requires --live and explicit user authorization. Promptfoo comparison is a separate operation."
    );
}
export function atomicJson(path: string, value: unknown) {
  writeFileSync(path + ".tmp", JSON.stringify(value, null, 2) + "\n");
  renameSync(path + ".tmp", path);
}
export async function generateReference(
  item: ReviewedCase,
  caseSha256: string,
  datasetSha256: string
) {
  pricingPerMillion[referenceModel] ??= referencePricing;
  const request = referenceRequest(item);
  const usage = new MissionUsageCollector();
  const api = new AgentsApi(new OpenAI({ maxRetries: 0, timeout: 300000 }), usage);
  const budget = new InvestigationBudget(
    { ...investigationLimits(), milliseconds: 300000, functionCalls: 32 },
    () => usage.summary()
  );
  api.budget = budget;
  const ref: SessionRef = { model: referenceModel, role: item.record.role, results: new Map() };
  const record: ReferenceRecord = {
    caseId: item.id,
    caseSha256,
    datasetSha256,
    role: item.record.role,
    model: referenceModel,
    effort: referenceEffort,
    startedAt: new Date().toISOString(),
    elapsedMs: 0,
    request,
    usage: usage.summary(),
    cleanup: { sessionDeleted: false, mcpClosed: false, errors: [] },
  };
  const started = Date.now();
  const tools: ReplayResult["tools"] = [];
  let mcp: Awaited<ReturnType<typeof connectMissionMcp>> | undefined;
  try {
    const director = item.record.role === "Mission Director";
    mcp = director ? undefined : await connectMissionMcp(replayContext(item).state);
    const allowed = new Set(mcp ? (await mcp.listTools()).tools.map((tool) => tool.name) : []);
    const handleDirector = directorToolHandler(item);
    const seen = new Set<string>();
    let calls = 0;
    const result = await api.withConsultationDeadline(ref, 300000, () =>
      api.start(ref, request.agent, request.input, async (call) => {
        let reply;
        if (director) reply = await handleDirector(call);
        else if (!allowed.has(call.name)) reply = toolError(call, "Unknown mission evidence tool.");
        else if (++calls > 4)
          reply = toolError(
            call,
            "Evidence lookup limit reached. Return a report with remaining uncertainty."
          );
        else {
          const key = call.name + ":" + JSON.stringify(parseArguments(call));
          if (seen.has(key))
            reply = toolError(
              call,
              "This source was already read in this consultation. Use the existing evidence."
            );
          else {
            seen.add(key);
            const value = await mcp!.callTool({
              name: call.name,
              arguments: parseArguments(call) as Record<string, unknown>,
            });
            reply = value.isError
              ? toolError(call, "Mission evidence lookup failed. Correct the arguments and retry.")
              : toolResult(call, value);
          }
        }
        tools.push({
          name: call.name,
          arguments: parseArguments(call),
          success: reply === null || reply.success,
          ...(reply?.success ? { output: reply.output } : {}),
          ...(reply && !reply.success ? { error: reply.error } : {}),
        });
        return reply;
      })
    );
    record.episode = {
      answer: result.pending ? parseArguments(result.pending) : JSON.parse(result.text),
      tools,
    };
    record.structuralCheck = gradeEpisode(JSON.stringify(record.episode), item);
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
  } finally {
    record.elapsedMs = Date.now() - started;
    record.sessionId = ref.id;
    record.turnId = ref.turnId;
    budget.finish();
    api.budget = undefined;
    try {
      await api.refreshUsage([ref]);
    } catch (error) {
      record.usageError = error instanceof Error ? error.message : String(error);
    }
    record.usage = usage.summary();
    try {
      await mcp?.close();
      record.cleanup.mcpClosed = true;
    } catch (error) {
      record.cleanup.errors.push(String(error));
    }
    try {
      await api.dispose(ref);
      record.cleanup.sessionDeleted = true;
    } catch (error) {
      record.cleanup.errors.push(String(error));
    }
  }
  return record;
}

async function main() {
  const args = process.argv.slice(2);
  const manifest = loadManifest();
  const datasetSha256 = sha256(readFileSync(join(directory, "dataset.json")));
  const plan = {
    mode: "reference generation; separate from held Promptfoo comparison",
    model: referenceModel,
    effort: referenceEffort,
    cases: manifest.cases.length,
    maxEpisodes: 45,
    concurrency: 3,
    timeoutSecondsPerEpisode: 300,
    retries: 0,
    originalCaseAnswerWithheld: true,
    gradingOracleWithheld: true,
    directorReports: "Fixed historical specialist input fixtures; not regenerated or hidden.",
    pricingPerMillion: referencePricing,
    pricingSource: "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
    datasetSha256,
  };
  if (!args.includes("--live")) {
    console.log(JSON.stringify({ ...plan, mode: "offline reference plan; no API calls" }, null, 2));
    return;
  }
  assertReferenceLive(args);
  if (manifest.version !== 4 || manifest.cases.length !== 45)
    throw new Error("Expected frozen v4 45-case suite.");
  const policy = readFileSync(join(directory, "execution-policy.json"));
  if (JSON.parse(policy.toString()).status !== "on_hold")
    throw new Error("Keep Promptfoo comparison on hold during reference generation.");
  const runArg = args.indexOf("--resume");
  const root =
    runArg < 0
      ? join(directory, "references", new Date().toISOString().replaceAll(":", "-"))
      : resolve(args[runArg + 1] ?? "");
  if (!root.startsWith(join(directory, "references") + "/"))
    throw new Error("Reference archive must be under references/.");
  mkdirSync(join(root, "cases"), { recursive: true });
  const path = join(root, "manifest.json");
  const run = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8"))
    : {
        ...plan,
        startedAt: new Date().toISOString(),
        revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        status: "running",
        rows: [] as unknown[],
      };
  if (
    run.datasetSha256 !== datasetSha256 ||
    run.model !== referenceModel ||
    run.effort !== referenceEffort
  )
    throw new Error("Resume request does not match the frozen reference batch.");
  atomicJson(path, run);
  const completed = new Set(run.rows.map((row: { caseId: string }) => row.caseId));
  const pending = manifest.cases.filter((entry) => !completed.has(entry.id));
  const collect = async (entry: (typeof pending)[number]) => {
    if (sha256(readFileSync(join(directory, "dataset.json"))) !== datasetSha256)
      throw new Error("Dataset changed during reference generation.");
    const caseBytes = readFileSync(join(directory, entry.file));
    if (sha256(caseBytes) !== entry.sha256) throw new Error("Case changed: " + entry.id);
    console.log(JSON.stringify({ event: "started", caseId: entry.id }));
    const record = await generateReference(loadCase(entry.id), entry.sha256, datasetSha256);
    const file = "cases/" + entry.id + ".json";
    atomicJson(join(root, file), record);
    run.rows.push({
      caseId: entry.id,
      file,
      sha256: sha256(readFileSync(join(root, file))),
      status: record.error ? "error" : "generated",
      structuralPass: record.structuralCheck?.pass,
      sessionDeleted: record.cleanup.sessionDeleted,
      elapsedMs: record.elapsedMs,
    });
    atomicJson(path, run);
    console.log(
      JSON.stringify({ event: "finished", ...run.rows.at(-1), completed: run.rows.length })
    );
    return record;
  };
  // The first real case also validates Agents API access/model/effort. It is
  // one of the 45, not an extra paid probe or a retry.
  if (pending.length) {
    const first = await collect(pending.shift()!);
    if (first.error || !first.cleanup.sessionDeleted)
      throw new Error(
        "First reference episode failed; batch stopped without retry. Inspect the saved record."
      );
  }
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (cursor < pending.length) await collect(pending[cursor++]);
    })
  );
  run.completedAt = new Date().toISOString();
  run.status =
    run.rows.length === 45 &&
    run.rows.every(
      (row: { status: string; sessionDeleted: boolean }) =>
        row.status === "generated" && row.sessionDeleted
    )
      ? "generated_awaiting_review"
      : "incomplete";
  atomicJson(path, run);
  if (!policy.equals(readFileSync(join(directory, "execution-policy.json"))))
    throw new Error("Comparison hold changed unexpectedly.");
  console.log(
    JSON.stringify({
      event: "batch_finished",
      directory: root,
      status: run.status,
      cases: run.rows.length,
    })
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
