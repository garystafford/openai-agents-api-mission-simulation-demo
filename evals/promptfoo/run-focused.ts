import "../../server/env.js";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { directory, loadCase, loadManifest } from "./dataset.js";
import { prepareReplay } from "./replay.js";
import { connectMissionMcp } from "../../server/mission-evidence.js";
import { buildRubric, gradingVersion } from "./grading-policy.js";
import { evidencePolicy, evidencePolicyVersion } from "./evidence-policy.js";
import { loadReferenceBundle } from "./reference-artifacts.js";
import { sha256 } from "./saved-comparison.js";
import { candidateKey, type FocusedFixture, type FocusedProfile } from "./focused-artifacts.js";

const root = resolve(directory, "../..");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const write = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
export async function prepareFocused(powerOnly = false) {
  const planFile = powerOnly ? "power-plan.json" : "focused-plan.json";
  const plan = json(resolve(directory, planFile));
  assert.equal(plan.candidateEpisodes, powerOnly ? 18 : 54);
  assert.equal(plan.maximumJudgeCalls, plan.candidateEpisodes);
  const runId =
    "focused-models-" +
    new Date()
      .toISOString()
      .replaceAll(":", "-")
      .replace(/\.\d+Z$/, "Z");
  const dir = resolve(directory, "results", runId);
  mkdirSync(dir, { recursive: false });
  const references = loadReferenceBundle();
  const fixtures: FocusedFixture[] = [];
  for (const entry of loadManifest().cases.filter((row) => row.role in plan.roles)) {
    const item = structuredClone(loadCase(entry.id));
    item.replay = prepareReplay(item.record);
    const mcp = await connectMissionMcp(item.replay.state);
    try {
      const tools = (await mcp.listTools()).tools;
      item.replay.agent.tools = tools.map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description ?? tool.name,
        parameters: tool.inputSchema,
      }));
    } finally {
      await mcp.close();
    }
    const rubric =
      buildRubric(item, references?.answers.get(item.id)?.answer) +
      "\n" +
      evidencePolicy.join("\n");
    fixtures.push({ item, rubric, sha256: sha256(JSON.stringify({ item, rubric })) });
  }
  assert.equal(fixtures.length, Object.keys(plan.roles).length * 9);
  if (powerOnly) {
    const prior = json(
      resolve(directory, "results", plan.sourceRun, "fixtures.json")
    ) as FocusedFixture[];
    assert.deepEqual(
      fixtures,
      prior.filter((row) => row.item.record.role === "Power & Thermal"),
      "Power fixtures must match the previous comparison exactly"
    );
  }
  for (const role of Object.keys(plan.roles))
    assert.equal(fixtures.filter((row) => row.item.record.role === role).length, 9);
  const sources = ["server", "evals/promptfoo"].flatMap((folder) =>
    readdirSync(resolve(root, folder))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => folder + "/" + file)
  );
  sources.push(
    "package.json",
    "package-lock.json",
    "evals/promptfoo/" + planFile,
    "evals/promptfoo/dataset.json"
  );
  write(resolve(dir, "fixtures.json"), fixtures);
  copyFileSync(resolve(directory, planFile), resolve(dir, "plan.snapshot.json"));
  writeFileSync(resolve(dir, "candidates.jsonl"), "");
  write(resolve(dir, "manifest.json"), {
    runId,
    preparedAt: new Date().toISOString(),
    gradingVersion,
    evidencePolicyVersion,
    fixtureSha256: sha256(readFileSync(resolve(dir, "fixtures.json"))),
    planSha256: sha256(readFileSync(resolve(dir, "plan.snapshot.json"))),
    sourceHashes: Object.fromEntries(
      sources.map((path) => [path, sha256(readFileSync(resolve(root, path)))])
    ),
    originalDatasetPreserved: true,
    productionDefaultsChanged: false,
  });
  console.log(
    JSON.stringify({
      prepared: runId,
      fixtures: fixtures.length,
      candidates: plan.candidateEpisodes,
      judgesAtMost: plan.maximumJudgeCalls,
      apiCalls: 0,
    })
  );
  return runId;
}

async function runFocused(runId: string) {
  assert(process.env.OPENAI_API_KEY, "Existing API key unavailable");
  assert.match(runId, /^focused-models-[0-9TZ-]+$/);
  const dir = resolve(directory, "results", runId);
  const manifest = json(resolve(dir, "manifest.json"));
  const plan = json(resolve(dir, "plan.snapshot.json"));
  assert.equal(sha256(readFileSync(resolve(dir, "fixtures.json"))), manifest.fixtureSha256);
  assert.equal(sha256(readFileSync(resolve(dir, "plan.snapshot.json"))), manifest.planSha256);
  for (const [path, hash] of Object.entries(manifest.sourceHashes))
    assert.equal(sha256(readFileSync(resolve(root, path))), hash, "Frozen source changed: " + path);
  assert(!existsSync(resolve(dir, "authorization.json")), "Run already attempted");
  const reuse = existsSync(resolve(dir, "reuse.json"))
    ? json(resolve(dir, "reuse.json"))
    : undefined;
  if (reuse) {
    assert.equal(sha256(readFileSync(resolve(dir, "candidates.jsonl"))), reuse.journalSha256);
    for (const row of reuse.records)
      if (row.file) assert.equal(sha256(readFileSync(resolve(dir, row.file))), row.sha256);
  } else assert.equal(readFileSync(resolve(dir, "candidates.jsonl"), "utf8"), "");
  const policyPath = resolve(directory, "execution-policy.json");
  const previous = json(policyPath);
  assert.equal(previous.status, "on_hold");
  // Metadata retrieval only: validate the existing project's model identifiers before inference.
  const client = new OpenAI({ maxRetries: 0, timeout: 30000 });
  for (const model of ["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"]) {
    const result = await client.models.retrieve(model);
    assert.equal(result.id, model);
  }
  const fixtures = json(resolve(dir, "fixtures.json")) as FocusedFixture[];
  const records = fixtures.flatMap((fixture) =>
    (plan.roles[fixture.item.record.role] as FocusedProfile[]).map((profile) => ({
      key: candidateKey(fixture.item.id, profile),
      fixtureSha256: fixture.sha256,
      reservationUsd: 0.5,
    }))
  );
  assert.equal(records.length, plan.candidateEpisodes);
  const authorization = {
    ...previous,
    status: "released",
    allowedOperations: ["candidate"],
    reason:
      "User approved the bounded matrix in plan.snapshot.json, followed by one judgment per saved answer.",
    focusedScope: {
      runId,
      maxCalls: plan.candidateEpisodes,
      estimatedBudgetUsd: plan.estimatedCandidateBudgetUsd,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      records,
    },
  };
  write(resolve(dir, "authorization.json"), authorization);
  let child: ReturnType<typeof spawn> | undefined;
  let interrupted = false;
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const phases: { phase: string; elapsedMs: number; exitCode: number | null }[] = [];
  let judgeDir: string | undefined;
  const restore = () => write(policyPath, previous);
  const stop = () => {
    interrupted = true;
    restore();
    child?.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  async function native(config: string, output: string, extraEnv: Record<string, string>) {
    assert(!interrupted, "Comparison interrupted");
    const phaseStarted = Date.now();
    child = spawn(
      process.execPath,
      [
        "node_modules/promptfoo/dist/src/entrypoint.js",
        "eval",
        "--config",
        "evals/promptfoo/" + config,
        "--no-cache",
        "--no-table",
        "--output",
        output,
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: {
          ...process.env,
          ...extraEnv,
          MARS_FOCUSED_RUN: runId,
          MARS_PROMPTFOO_LIVE: "1",
          PROMPTFOO_DISABLE_TELEMETRY: "1",
          PROMPTFOO_CACHE_ENABLED: "false",
          PROMPTFOO_CONFIG_DIR: resolve(directory, ".promptfoo"),
          REQUEST_TIMEOUT_MS: "180000",
          MISSION_INVESTIGATION_SECONDS: "240",
          MISSION_SPECIALIST_SECONDS: "120",
          MISSION_MAX_ESTIMATED_COST_USD: "2",
          MISSION_MAX_TOKENS: "500000",
          LOG_LEVEL: "info",
        },
      }
    );
    const code = await new Promise<number | null>((done, reject) => {
      child!.once("error", reject);
      child!.once("exit", done);
    });
    phases.push({
      phase: config + ":" + (extraEnv.MARS_FOCUSED_ROLE ?? "judge"),
      elapsedMs: Date.now() - phaseStarted,
      exitCode: code,
    });
    assert(!interrupted, "Comparison interrupted");
    assert(
      existsSync(output) && (code === 0 || code === 100),
      "Native phase did not finish; no automatic retry"
    );
  }
  try {
    write(policyPath, authorization);
    for (const role of Object.keys(plan.roles)) {
      console.log("Starting focused candidate phase: " + role);
      await native(
        "focused-config.ts",
        resolve(dir, role === "Risk Review" ? "risk.promptfoo.json" : "power.promptfoo.json"),
        { MARS_FOCUSED_ROLE: role }
      );
    }
    restore();
    const candidateEvents = readFileSync(resolve(dir, "candidates.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const completed = candidateEvents.filter((event) => event.phase === "completed");
    assert.equal(
      candidateEvents.filter((event) => event.phase === "started").length,
      plan.candidateEpisodes,
      "Incomplete candidate phase; report before any extra calls"
    );
    assert.equal(completed.length, plan.candidateEpisodes);
    const judgeCases = completed
      .filter((event) => event.file)
      .map((event) => {
        const result = json(resolve(dir, event.file));
        const fixture = fixtures.find((row) => event.key.startsWith(row.item.id + "::"))!;
        const [model, effort] = event.key.split("::")[1].split(":");
        assert.equal(typeof result.output, "string");
        assert.equal(
          JSON.stringify(JSON.parse(result.output)),
          result.output,
          "Canonical JSON output required by native llm-rubric binding"
        );
        return {
          key: event.key,
          caseId: fixture.item.id,
          role: fixture.item.record.role,
          model,
          effort,
          output: result.output,
          rubric: fixture.rubric,
        };
      });
    assert(judgeCases.length > 0 && judgeCases.length <= plan.maximumJudgeCalls);
    write(resolve(dir, "judge-cases.json"), judgeCases);
    const judgeRun = "judge-" + runId.replace("focused-models-", "focused-");
    judgeDir = resolve(directory, "results", judgeRun);
    mkdirSync(judgeDir, { recursive: false });
    writeFileSync(resolve(judgeDir, "calls.jsonl"), "");
    const judgeAuthorization = {
      status: "released",
      allowedOperations: ["judge"],
      reason:
        "Single authorized saved-output judgment per focused candidate; candidate phase closed.",
      judgeScope: {
        kind: "focused",
        runId: judgeRun,
        maxCalls: judgeCases.length,
        estimatedBudgetUsd: plan.estimatedJudgeBudgetUsd,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        records: judgeCases.map((row) => ({
          key: row.key,
          outputSha256: sha256(row.output),
          rubricSha256: sha256(row.rubric),
        })),
      },
    };
    write(resolve(judgeDir, "authorization.json"), judgeAuthorization);
    write(resolve(dir, "judge-link.json"), {
      judgeRun,
      judgeDirectory: judgeDir,
      expected: judgeCases.length,
      estimatedBudgetUsd: plan.estimatedJudgeBudgetUsd,
    });
    console.log("Starting " + judgeCases.length + " saved-output judgments");
    await native("focused-judge-config.ts", resolve(dir, "judge.promptfoo.json"), {
      MARS_JUDGE_CALIBRATION_RUN: judgeRun,
      MARS_JUDGE_AUTHORIZATION_FILE: resolve(judgeDir, "authorization.json"),
    });
  } finally {
    restore();
    if (judgeDir) {
      const judgeAuthorization = json(resolve(judgeDir, "authorization.json"));
      write(resolve(judgeDir, "authorization.closed.json"), {
        ...judgeAuthorization,
        status: "on_hold",
        allowedOperations: [],
      });
      // Preserve the original permit as evidence, but close the effective file.
      copyFileSync(
        resolve(judgeDir, "authorization.json"),
        resolve(judgeDir, "authorization.snapshot.json")
      );
      copyFileSync(
        resolve(judgeDir, "authorization.closed.json"),
        resolve(judgeDir, "authorization.json")
      );
    }
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    write(resolve(dir, "timing.json"), {
      startedAt,
      completedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      interrupted,
      phases,
      paidStatus: "on_hold",
    });
    console.log("Focused batch stopped; all paid operations on hold. Artifacts: " + dir);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes("--prepare")) await prepareFocused(process.argv.includes("--power"));
  else {
    assert(
      process.argv.includes("--live"),
      "Use --prepare offline or --live --run <prepared-run-id>"
    );
    const index = process.argv.indexOf("--run");
    assert(index >= 0 && process.argv[index + 1], "Prepared run required");
    await runFocused(process.argv[index + 1]);
  }
}
