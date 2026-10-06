// A subprocess fixture: proves restoration with a genuinely empty process registry.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentsApi, type SessionRef, type FunctionCall } from "../server/agents-api.js";
import {
  configureAgentStorage,
  runMissionDirector,
  pendingMissionApproval,
  resolveMissionApproval,
} from "../server/agents.js";
import { createMission, type MissionState } from "../server/mission.js";
const [directory, stage] = process.argv.slice(2);
process.env.OPENAI_API_KEY = "test-only-no-network";
configureAgentStorage(join(directory, "agents"));
const plan = {
  headline: "Protect crew",
  actions: ["recall_eva" as const],
  rationale: "Evidence reviewed",
  uncertainties: [],
  approvalScope: "Crew recall only",
};
const call = (ref: SessionRef, name: string, args: unknown): FunctionCall => ({
  type: "function_call",
  call_id: name,
  turn_id: ref.turnId!,
  name,
  arguments: args,
});
AgentsApi.prototype.refreshUsage = async () => {};
if (stage === "create") {
  AgentsApi.prototype.start = async (ref, _agent, _input, handler) => {
    ref.id = "hosted-" + ref.role;
    ref.turnId = "turn-" + ref.role;
    if (ref.role === "Mission Director") {
      await handler(call(ref, "consult_power", { question: "Review reserves" }));
      const pending = call(ref, "submit_mission_plan", plan);
      await handler(pending);
      return { text: "", pending };
    }
    await handler(call(ref, "mcp_read_mission_telemetry", { system: "all" }));
    return {
      text: JSON.stringify({
        status: "watch",
        confidence: 0.8,
        recommendation: "Review crew recall",
        evidence: ["Current telemetry reviewed"],
        tradeoff: "Travel takes time",
      }),
    };
  };
  const state = createMission();
  const result = await runMissionDirector(state);
  writeFileSync(
    join(directory, "state.json"),
    JSON.stringify({ ...state, selectedPlan: result.plan, proposalId: result.proposalId })
  );
  console.log("saved");
} else {
  const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as MissionState;
  const pending = pendingMissionApproval(state.missionId);
  if (pending?.id !== state.proposalId) throw new Error("Pending approval was not restored");
  AgentsApi.prototype.resume = async (ref, result) => {
    if (
      ref.id !== "hosted-Mission Director" ||
      result.call_id !== "submit_mission_plan" ||
      !result.success
    )
      throw new Error("Wrong restored decision target");
    ref.results.set(result.call_id, result);
    return { text: JSON.stringify(plan) };
  };
  const completion = await resolveMissionApproval(state, true, state.proposalId!);
  if (completion.awaitingApproval || pendingMissionApproval(state.missionId))
    throw new Error("Approval can be replayed");
  console.log("restored-and-consumed");
}
