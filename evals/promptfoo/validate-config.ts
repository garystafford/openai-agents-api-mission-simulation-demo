// Native Promptfoo parsing/provider loading only. Never call evaluate/callApi.
process.env.PROMPTFOO_DISABLE_TELEMETRY = "1";
process.env.PROMPTFOO_CONFIG_DIR = new URL("../../.promptfoo/", import.meta.url).pathname;
const { UnifiedConfigSchema, loadApiProvider } = await import("promptfoo");
const { default: config } = await import("./promptfooconfig.js");
const parsed = UnifiedConfigSchema.safeParse(config);
if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues, null, 2));
const ids: string[] = [];
for (const provider of config.providers) {
  const instance = await loadApiProvider(
    "file://" + new URL("./provider.ts", import.meta.url).pathname,
    {
      options: { config: provider.config },
    }
  );
  ids.push(instance.id());
}
if (new Set(ids).size !== 3) throw new Error("Candidate provider IDs must be distinct.");
const judgeConfig = config.defaultTest.assert[1].provider!;
const judge = (await loadApiProvider(
  judgeConfig.id.startsWith("file://")
    ? "file://" + new URL(judgeConfig.id.slice("file://".length), import.meta.url).pathname
    : judgeConfig.id,
  {
    options: { config: judgeConfig.config },
  }
)) as unknown as {
  getOpenAiBody(prompt: string): Promise<{
    body: {
      model: string;
      reasoning?: { effort?: string };
      max_output_tokens?: number;
      temperature?: number;
    };
  }>;
};
const { body: judgeBody } = await judge.getOpenAiBody("Offline request-shape verification only.");
if (judgeBody.model !== "gpt-6-sol" || judgeBody.reasoning?.effort !== "medium")
  throw new Error(
    "Semantic judge request must preserve the fixed model and reasoning effort: " +
      JSON.stringify({ model: judgeBody.model, reasoning: judgeBody.reasoning })
  );
if (judgeBody.max_output_tokens !== 4096 || judgeBody.temperature !== undefined)
  throw new Error("Semantic judge must retain its output cap and omit the default temperature.");
console.log(
  JSON.stringify({
    valid: true,
    promptfoo: "0.123.1",
    cases: config.tests.length,
    providerIds: ids,
    judge: { model: judgeBody.model, effort: judgeBody.reasoning.effort },
    apiCalls: 0,
  })
);
