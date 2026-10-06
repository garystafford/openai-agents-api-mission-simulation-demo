import { testPlan } from "./fixtures.js";
import {
  advanceMission,
  approveCommand,
  createMission,
  randomScenarioId,
  requestCommand,
  scenarioIds,
} from "../server/mission.js";
import { MissionUsageCollector } from "../server/mission-usage.js";

const cases = [
  {
    name: "five distinct incident scenarios are available",
    run: () => new Set(scenarioIds.map((id) => createMission(id).scenario.title)).size === 5,
  },
  {
    name: "each incident presents timestamped diagnostic telemetry",
    run: () =>
      scenarioIds.every((id) =>
        createMission(id).telemetry.every(
          (reading) => reading.sampledAtMinutes === 0 && reading.history?.length === 1
        )
      ),
  },
  {
    name: "random incident selection does not immediately repeat the current scenario",
    run: () => scenarioIds.every((id) => randomScenarioId(id) !== id),
  },
  {
    name: "approval gate appears before any command is applied",
    run: () => Boolean(requestCommand(createMission(), testPlan(["recall_eva"])).pendingCommand),
  },
  {
    name: "complete dust-storm plan protects the returning EVA crew",
    run: () => {
      const pending = requestCommand(
        createMission(),
        testPlan(["recall_eva", "isolate_scrubber", "shed_nonessential_load"])
      );
      const approved = approveCommand(pending, true);
      const firstReport = advanceMission(approved);
      const secondReport = advanceMission(firstReport);
      let finalReport = advanceMission(secondReport);
      while (finalReport.phase === "executing") finalReport = advanceMission(finalReport);
      return (
        approved.phase === "executing" &&
        firstReport.simulation.conditions.crewReturnMinutes === 7 &&
        secondReport.simulation.conditions.crewReturnMinutes === 3 &&
        finalReport.phase === "resolved" &&
        finalReport.telemetry.find((item) => item.label === "EVA crew")?.status === "nominal"
      );
    },
  },
  {
    name: "incomplete plan produces a degraded outcome rather than pretending success",
    run: () =>
      [1, 2, 3].reduce(
        (state) => advanceMission(state),
        approveCommand(requestCommand(createMission(), testPlan(["recall_eva"])), true)
      ).outcome === "degraded",
  },
  {
    name: "declined command resumes assessment without changing mission configuration",
    run: () => {
      const pending = requestCommand(createMission(), testPlan(["recall_eva"]));
      const resumed = approveCommand(pending, false);
      return resumed.phase === "assessment" && !resumed.pendingCommand;
    },
  },
  {
    name: "mission cost separates cached input and reasoning without double charging output",
    run: () => {
      const collector = new MissionUsageCollector();
      collector.record(
        "usage-eval-1",
        {
          input_tokens: 1000,
          output_tokens: 500,
          total_tokens: 1500,
          input_tokens_details: { cached_tokens: 100 },
          output_tokens_details: { reasoning_tokens: 300 },
        },
        "gpt-6-sol"
      );
      const usage = collector.summary();
      return (
        usage.inputTokens === 1000 &&
        usage.cachedInputTokens === 100 &&
        usage.reasoningTokens === 300 &&
        usage.visibleOutputTokens === 200 &&
        usage.outputTokens === 500 &&
        usage.estimatedCostUsd === 0.00682
      );
    },
  },
];

const results = cases.map((test) => ({ name: test.name, pass: test.run() }));
for (const result of results) console.log((result.pass ? "PASS " : "FAIL ") + result.name);
if (results.some((result) => !result.pass)) process.exit(1);
