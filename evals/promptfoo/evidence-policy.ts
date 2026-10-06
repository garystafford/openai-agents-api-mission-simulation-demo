// A separate version preserves the frozen materiality-v3 policy and old run rubrics.
export const evidencePolicyVersion = "evidence-scope-v1";
export const evidencePolicy = [
  "Evidence provenance policy: " + evidencePolicyVersion,
  "RECEIVED evidence is the actual evaluation input, instructions, visible earlier session context and successful tool results in this candidate's audit. Determine what the candidate received from those exact fields; a broader evaluator projection is not proof of receipt.",
  "RETRIEVABLE evidence below is public information available through permitted tools. Assess retrieval completeness separately: when an explicit requested calculation cannot be answered without a retrievable rate/duration, an unjustified failure to acquire it can leave the task incomplete. Cite the required query and omission; never say the candidate ignored a value already supplied unless RECEIVED evidence contains it.",
  "A correct conditional answer may identify a genuinely unreceived reading as uncertain. For a request to identify remaining uncertainty, that statement alone is not a factual error simply because another permitted query could retrieve it. Distinguish 'not returned by this query' from 'no available tool can supply it'.",
  "If an ambiguous tool filter or source contract prevents fair attribution, use NEEDS_REVIEW. Do not repair an ambiguous contract retroactively. Private simulator state, hidden dynamics, oracle outcomes and future context are never candidate evidence.",
];
