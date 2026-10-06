import { gradeEpisode } from "./assertions.js";
import { focusedFixtures } from "./focused-artifacts.js";
export default function assertion(output: string, context: { vars: { caseId: string } }) {
  const fixture = focusedFixtures().find((value) => value.item.id === context.vars.caseId);
  if (!fixture) throw new Error("Unknown frozen focused case");
  return gradeEpisode(output, fixture.item);
}
