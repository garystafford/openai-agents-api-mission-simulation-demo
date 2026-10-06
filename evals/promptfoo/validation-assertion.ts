import { loadValidationCases } from "./validation-cases.js";

export default function assertion(output: string, context: { vars: { savedKey: string } }) {
  const item = loadValidationCases().cases.find((row) => row.key === context.vars.savedKey);
  if (!item || item.output !== output)
    throw new Error("Validation output changed after preparation");
  return item.deterministic;
}
