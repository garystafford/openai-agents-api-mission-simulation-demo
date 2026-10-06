import { appendFileSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import MissionAgentProvider from "./provider.js";
import { assertComparisonReleased } from "./execution-policy.js";
import { claimFocusedCandidate, focusedFixtures, focusedDirectory } from "./focused-artifacts.js";

export default class FocusedProvider extends MissionAgentProvider {
  protected focused = true;
  protected loadReplayCase(id: string) {
    const fixture = focusedFixtures().find((value) => value.item.id === id);
    if (!fixture) throw new Error("Unknown frozen focused case");
    return fixture.item;
  }
  protected validateConfiguration() {
    if (
      !["gpt-6-luna", "gpt-6-sol", "gpt-6-astra"].includes(this.config.model) ||
      !["low", "medium", "high"].includes(this.config.effort)
    )
      throw new Error("Unsupported focused configuration");
  }
  async callApi(prompt: string) {
    const reusePath = resolve(focusedDirectory(), "reuse.json");
    if (existsSync(reusePath)) {
      const reuse = JSON.parse(readFileSync(reusePath, "utf8"));
      const key = prompt.trim() + "::" + this.config.model + ":" + this.config.effort;
      const row = reuse.records.find((item: { key: string }) => item.key === key);
      if (row) {
        if (row.error) throw new Error("Preserved previous attempt: " + row.error);
        console.log("Reusing completed candidate: " + key);
        return JSON.parse(readFileSync(resolve(focusedDirectory(), row.file), "utf8"));
      }
    }
    const claim = claimFocusedCandidate(assertComparisonReleased(), prompt.trim(), this.config);
    const started = Date.now();
    try {
      const result = await super.callApi(prompt);
      const file = claim.key.replaceAll(/[^a-zA-Z0-9_.-]/g, "_") + ".json";
      writeFileSync(resolve(focusedDirectory(), file), JSON.stringify(result, null, 2) + "\n");
      // Unknown charges retain the conservative reservation. The 25% padding
      // allows for unretained cache writes at standard short-context rates.
      const chargedEstimateUsd =
        result.metadata.accountingPending || result.cost === undefined
          ? claim.reservationUsd
          : result.cost * 1.25;
      appendFileSync(
        claim.journal,
        JSON.stringify({
          phase: "completed",
          key: claim.key,
          file,
          elapsedMs: Date.now() - started,
          chargedEstimateUsd,
          cost: result.cost,
          accountingPending: result.metadata.accountingPending,
          completedAt: new Date().toISOString(),
        }) + "\n"
      );
      console.log(
        `Candidate completed: ${claim.key} (${((Date.now() - started) / 1000).toFixed(1)}s)`
      );
      return result;
    } catch (error) {
      appendFileSync(
        claim.journal,
        JSON.stringify({
          phase: "completed",
          key: claim.key,
          error: String(error),
          elapsedMs: Date.now() - started,
          chargedEstimateUsd: claim.reservationUsd,
          completedAt: new Date().toISOString(),
        }) + "\n"
      );
      throw error;
    }
  }
}
