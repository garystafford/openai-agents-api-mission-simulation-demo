import { loadValidationCases } from "./validation-cases.js";

export default class ValidationSavedProvider {
  id() {
    return "saved-fresh-validation";
  }
  async callApi(key: string) {
    const item = loadValidationCases().cases.find((row) => row.key === key.trim());
    if (!item) throw new Error("Unknown validation recording");
    return {
      output: item.output,
      cached: false,
      cost: 0,
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
    };
  }
}
