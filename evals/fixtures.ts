import type { DecisionPlan, MissionAction } from "../server/mission-contract.js";

// Simulator tests provide a complete proposal just as the agent runtime does.
export function testPlan(actions: MissionAction[]): DecisionPlan {
  return {
    headline: "Test response",
    actions,
    rationale: "Evaluate the selected command effects.",
    uncertainties: [],
    approvalScope: "Authorize these fictional simulator commands.",
  };
}
