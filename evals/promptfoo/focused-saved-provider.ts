import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { focusedDirectory } from "./focused-artifacts.js";
export function focusedJudgeCases(): {
  key: string;
  caseId: string;
  output: string;
  rubric: string;
  model: string;
  effort: string;
  role: string;
}[] {
  return JSON.parse(readFileSync(resolve(focusedDirectory(), "judge-cases.json"), "utf8"));
}
export default class FocusedSavedProvider {
  id() {
    return "saved-focused-candidate";
  }
  async callApi(key: string) {
    const row = focusedJudgeCases().find((value) => value.key === key.trim());
    if (!row) throw new Error("Unknown frozen focused output");
    return {
      output: row.output,
      cached: false,
      cost: 0,
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
    };
  }
}
