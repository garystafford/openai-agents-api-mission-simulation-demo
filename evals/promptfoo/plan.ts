import config from "./promptfooconfig.js";
import { loadManifest } from "./dataset.js";
import { loadReferenceBundle } from "./reference-artifacts.js";
const manifest = loadManifest();
const references = loadReferenceBundle();
console.log(
  JSON.stringify(
    {
      mode: "offline plan; no API calls",
      datasetVersion: manifest.version,
      referenceStatus: references?.index.status ?? manifest.referenceStatus,
      reviewedReferences: references?.answers.size ?? 0,
      cases: config.tests.length,
      perAgent: Object.fromEntries(
        [...new Set(manifest.cases.map((item) => item.role))].map((role) => [
          role,
          manifest.cases.filter((item) => item.role === role).length,
        ])
      ),
      candidates: config.providers.map((provider) => provider.label),
      repetitions: config.evaluateOptions.repeat,
      candidateEpisodes:
        config.tests.length * config.providers.length * config.evaluateOptions.repeat,
      semanticJudge:
        "gpt-6-sol / medium; additional paid calls only during explicitly authorized evaluation",
      note: "Agent episodes can contain multiple model/tool turns. This suite ranks Luna reasoning settings; it does not establish a winner across model families.",
    },
    null,
    2
  )
);
