import { focusedFixtures, focusedPlan } from "./focused-artifacts.js";
const role = process.env.MARS_FOCUSED_ROLE;
const profiles = focusedPlan().roles[role ?? ""];
if (!profiles) throw new Error("Focused role required");
export default {
  description: "Frozen focused model comparison: " + role,
  prompts: ["{{caseId}}"],
  providers: profiles.map((profile: { model: string; effort: string }) => ({
    id: "file://./focused-provider.ts",
    label: profile.model + ":" + profile.effort,
    config: profile,
  })),
  evaluateOptions: { repeat: 1, maxConcurrency: 4, cache: false },
  defaultTest: { assert: [{ type: "javascript", value: "file://./focused-assertion.ts" }] },
  tests: focusedFixtures()
    .filter((fixture) => fixture.item.record.role === role)
    .map((fixture) => ({
      description: fixture.item.id,
      vars: { caseId: fixture.item.id },
      metadata: { role, fixtureSha256: fixture.sha256 },
    })),
};
