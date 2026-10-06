// Offline Promptfoo adapter: returns a hash-bound saved mission, never calls a model.
import { createHash } from "node:crypto";
export default class SavedFinalTeamProvider {
  id() {
    return "saved-final-team";
  }
  async callApi(_prompt, context) {
    const output = context.vars.savedMission;
    const hash = createHash("sha256").update(output).digest("hex");
    if (hash !== context.vars.outputSha256) throw new Error("Saved mission hash mismatch");
    return { output, cached: true, cost: 0 };
  }
}
