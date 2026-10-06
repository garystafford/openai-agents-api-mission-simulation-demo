import { loadSavedComparison, savedKey } from "./saved-comparison.js";

// Exactly reuses original answer and audit bytes. Never starts an agent or accesses a key.
export default class SavedOutputProvider {
  private saved?: ReturnType<typeof loadSavedComparison>;
  id() {
    return "saved-candidate-output";
  }
  async callApi(key: string) {
    this.saved ??= loadSavedComparison();
    const row = this.saved.rows.find((item) => savedKey(item) === key.trim());
    if (!row) throw new Error("Unknown saved candidate key");
    return {
      output: row.response.output,
      cached: false,
      cost: 0,
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      metadata: {
        mode: "saved-output retrieval; candidate API not called",
        originalEvalId: this.saved.evalId,
        originalRecordId: row.id,
        originalCandidate: row.provider.id,
        originalCaseId: row.testCase.vars.caseId,
      },
    };
  }
}
