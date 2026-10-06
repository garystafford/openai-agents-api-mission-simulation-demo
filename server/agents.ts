import { missionRules } from "./mission-rules.js";
import { missionTeam } from "./mission-team.js";
import { randomUUID } from "node:crypto";
import {
  specialistDeadlineMilliseconds,
  InvestigationBudget,
  InvestigationError,
} from "./investigation-budget.js";
import { agentProfiles } from "./agent-profiles.js";
import {
  ConsultationTimeoutError,
  toolResult,
  toolError,
  type FunctionCall,
  type ToolResult,
} from "./agents-api.js";
import { arithmeticValidationFeedback, evidenceFailureFeedback } from "./mission-arithmetic.js";
import { traceMissionOperation } from "./instrumentation.js";
import { missionEvidence, connectMissionMcp } from "./mission-evidence.js";
import {
  checkpointInvestigation,
  investigationFor,
  createInvestigation,
  clearMissionSession,
  collectUsage,
  type Investigation,
} from "./mission-investigations.js";
import {
  specialistAdviceSchema,
  decisionPlanSchema,
  questionSchema,
  batchConsultationSchema,
  parseBatchConsultations,
  validateMissionPlan,
  planValidationFeedback,
  validateAuthorizedPlan,
  functionTool,
  parseArguments,
  structuredText,
} from "./agent-schemas.js";
import type { CouncilLog, MissionState, SpecialistReport } from "./mission-contract.js";

// Preserve the runtime's public entry points while keeping lifecycle and schemas separate.
export {
  configureAgentStorage,
  suspendMissionSessions,
  pendingMissionApproval,
  clearMissionSession,
  missionUsage,
} from "./mission-investigations.js";
export {
  validateMissionPlan,
  planValidationFeedback,
  validateAuthorizedPlan,
} from "./agent-schemas.js";

type CouncilActivity = (entry: Omit<CouncilLog, "id">) => void;
type ReportActivity = (report: SpecialistReport) => void;
const specialties = {
  consult_power: {
    name: "Power & Thermal",
    description: "Ask Power & Thermal to analyze power and thermal risk.",
  },
  consult_life_support: {
    name: "Life Support",
    description: "Ask Life Support to analyze breathable-cabin and scrubber risk.",
  },
  consult_weather: {
    name: "Weather & Navigation",
    description: "Ask Weather & Navigation to analyze weather, navigation, and crew-location risk.",
  },
  consult_red_team: {
    name: "Risk Review",
    description: "Ask Risk Review to challenge assumptions, evidence gaps, and unsafe trade-offs.",
  },
} as const;

export function missionDirectorInput(state: MissionState, reviewRequest?: string) {
  return [
    "Incident: " + state.scenario.title + ".",
    state.scenario.briefing,
    "Active risks: " + state.scenario.activeRisks.join("; ") + ".",
    "Available actions: " + state.scenario.availableActions.join(", ") + ".",
    "Current response window: " +
      state.minutesToImpact +
      " minutes; elapsed simulated time: " +
      state.simulation.elapsedMinutes +
      " minutes.",
    "Current observations and outcome targets: " + JSON.stringify(missionEvidence(state)),
    "Previous execution results: " + JSON.stringify(state.simulation.commands),
    "Last observed outcome: " + (state.outcome ?? "No response has been evaluated yet."),
    ...(reviewRequest
      ? [
          "Commander review request: " + reviewRequest,
          "Previous proposal: " + JSON.stringify(state.selectedPlan ?? {}),
        ]
      : []),
  ].join(" ");
}

export function directorInstructions() {
  return (
    [
      "You are the Ares-7 Mission Director in a fictional training simulator with modeled action effects. Form an adaptive evidence-based incident response.",
      "Consult at least one relevant specialist for fresh evidence. Choose only specialists that materially reduce uncertainty. Call Risk Review when assumptions or unsafe trade-offs need challenge.",
      "When two or more specialists can investigate independently, use consult_specialists to request their assessments concurrently in one call. Give each a focused question. Use the exact responseWindow from current evidence: final confirmation ends at the hazard deadline, not one minute after it. Ask about later times only as explicitly labeled sensitivities. Use individual consultation tools for follow-ups that depend on earlier reports; do not batch dependent questions.",
      "Each specialist retains its earlier consultation context within this mission. Normally consult each relevant role once, then submit when the collected evidence supports a plan. Ask follow-ups only for a specific unresolved question that can change the plan; do not repeat confirmation of unchanged readings or ask specialists to invent missing simulator data.",
      "Address commander review requests directly. Retain a sound plan or revise it when evidence warrants a change.",
      "Every specialist you request must complete successfully before a proposal is allowed. A timed-out specialist makes this assessment incomplete even if other reports succeeded. Do not retry, request replacement consultations, or submit a partial-evidence plan. Explain the missing assessment; completed reports are diagnostic evidence only. A new assessment requires an explicit commander request. Never invent missing specialist findings.",
      "Use only available actions. Choose actions to meet the measured outcome objectives; no action checklist determines success. Account for command duration, prerequisites, resource use, and the remaining impact window using evidence tools. After an unsuccessful execution, reassess current conditions and command results rather than restarting from the original briefing. Infer the necessary response from mission evidence and specialist reports, prioritizing crew and life-critical capability. State missing real-world readings as uncertainty rather than inventing them. All actions are simulated and require explicit human authorization.",
      "Commands in one proposal start together and progress with second-level simulation timing, waiting for prerequisites. Array order does not express a sequential schedule; do not promise an unsupported execution order. A baseline sample has no trend. Repeated consultation cannot create missing historical readings or advance the simulation; report that limitation as uncertainty.",
      "Before submission, check that headline, actions, rationale, uncertainties (at most three items), and nonempty approvalScope are present. approvalScope requests commander authorization; it does not grant it. Call submit_mission_plan with the exact proposal. The application holds its result until the commander decides. Finish without this call only when a requested specialist is unavailable; explain that the assessment is incomplete.",
      "After authorization return exactly the submitted plan, unchanged. After a declined or superseded proposal, stop immediately with no further tool calls and return the old proposal only as a record, never as an authorized command.",
    ].join(" ") +
    " Current simulator rules: " +
    JSON.stringify(missionRules) +
    " Cross-check specialist arithmetic and reject unsupported prerequisites or claims. Prioritize crew safety and life support when full recovery is infeasible. A reserve shortfall remains an unmet objective even if the commander accepts a crew-first mitigation. Explicitly include recall in the proposal for rover rescue; repair alone does not bring crew home."
  );
}

export function specialistInstructions(name: string) {
  return (
    [
      "You are the " + name + " specialist on Ares-7.",
      "Your session lasts for this mission. Build on earlier findings when the Director asks a follow-up question; revise them when new evidence warrants it.",
      "During every consultation, use mcp_read_mission_telemetry or mcp_query_mission_protocol before advising. Current evidence takes precedence over earlier readings. Use sample times and recent history to distinguish recovery from continued deterioration; a falling value is not necessarily safer. Diagnostic thresholds and rates are synthetic training rules. Request a current simulated cross-check when it can resolve a material uncertainty; it shares the simulator sources and is not an independent physical sensor.",
      "These are time-stamped simulator observations. Missing readings cannot be obtained by repeating a lookup. During each consultation, call each evidence tool/source at most once, use at most four evidence calls, then return your report with any unresolved uncertainty.",
      "Return concise structured advice with recommendation, evidence, confidence, and one trade-off. Recommend commander authorization; the Director only proposes. Proofread once for repeated sentences, garbled clauses and unrelated words. Never execute a mission command.",
      "The arithmetic tool accepts at most eight calculations per call and labels of at most 100 characters. Rejected calls still use the four-call budget. Correct invalid arguments only if calls remain; otherwise identify the failed forecasts as unverified. Never describe a rejected calculation as checked.",
    ].join(" ") +
    " Current simulator rules: " +
    JSON.stringify(missionRules) +
    " Answer the actual crew location and role-specific question. Reject a Director question's false timing or prerequisite premise using the explicit responseWindow and recallPrerequisites from current evidence. Optional post-deadline projections never redefine final confirmation. For calculations name start, prerequisite wait, completion and forecast times, include all active loads, and use mcp_check_arithmetic for reported numerical forecasts. Read mission evidence first and keep calculation calls within the four-call budget; one calculation call can check several forecasts. The calculator does not validate your assumptions. Distinguish executable actions from unavailable external assistance. Keep output free of stray tokens and unsupported contingencies."
  );
}

async function assessSpecialist(
  investigation: Investigation,
  state: MissionState,
  specialty: (typeof specialties)[keyof typeof specialties],
  question: string,
  record: CouncilActivity,
  onReport: ReportActivity
) {
  const { name } = specialty;
  const { role } = missionTeam.find((member) => member.name === name)!;
  const continuing = Boolean(investigation.sessions.ref(name).id);
  const profile = agentProfiles[name];
  const mcpTools = (await investigation.mcp!.listTools()).tools;
  const allowed = new Map(mcpTools.map((tool) => [tool.name, tool]));
  let evidenceRead = false;
  let evidenceCalls = 0;
  const sources = new Set<string>();
  record({
    speaker: name,
    kind: "api",
    message: continuing
      ? "Continued the mission assessment with earlier findings in context."
      : "Joined the mission assessment.",
  });
  return traceMissionOperation(
    "specialist." + name,
    { "openinference.span.kind": "AGENT", "llm.model_name": profile.model },
    async () => {
      const result = await investigation.api.withConsultationDeadline(
        investigation.sessions.ref(name),
        specialistDeadlineMilliseconds(),
        () =>
          investigation.sessions.run(
            name,
            {
              model: profile.model,
              reasoning: { effort: profile.reasoningEffort },
              instructions: specialistInstructions(name),
              tools: mcpTools.map((tool) => ({
                type: "function",
                name: tool.name,
                description: tool.description ?? tool.name,
                parameters: tool.inputSchema,
              })),
              text: structuredText(specialistAdviceSchema),
            },
            "Current incident: " + state.scenario.title + ". Director request: " + question,
            async (call) => {
              if (!allowed.has(call.name)) return toolError(call, "Unknown mission evidence tool.");
              if (++evidenceCalls > 4)
                return toolError(
                  call,
                  "Evidence lookup limit reached. Return a report with remaining uncertainty."
                );
              const source = call.name + ":" + JSON.stringify(parseArguments(call));
              if (sources.has(source))
                return toolError(
                  call,
                  "This source was already read in this consultation. Use the existing evidence."
                );
              sources.add(source);
              const validation = arithmeticValidationFeedback(
                call.name,
                parseArguments(call),
                evidenceCalls
              );
              if (validation) {
                record({ speaker: name, kind: "evidence", message: validation });
                return toolError(call, validation);
              }
              record({
                speaker: name,
                kind: "evidence",
                message:
                  {
                    mcp_read_mission_telemetry: "Requested the latest mission telemetry.",
                    mcp_query_mission_protocol: "Consulted mission safety protocols.",
                    mcp_check_arithmetic: "Requested a numerical arithmetic check.",
                    mcp_request_independent_verification:
                      "Requested a current simulated cross-check of the evidence.",
                  }[call.name] ?? "Requested mission evidence.",
              });
              const output = await traceMissionOperation(
                "mcp." + call.name,
                { "openinference.span.kind": "TOOL" },
                () =>
                  investigation.mcp!.callTool({
                    name: call.name,
                    arguments: parseArguments(call) as Record<string, unknown>,
                  })
              );
              if (output.isError) return toolError(call, evidenceFailureFeedback(evidenceCalls));
              if (
                call.name === "mcp_read_mission_telemetry" ||
                call.name === "mcp_query_mission_protocol"
              )
                evidenceRead = true;
              return toolResult(call, output);
            }
          )
      );
      if (!evidenceRead) throw new Error(name + " did not consult a mission evidence source.");
      const advice = specialistAdviceSchema.parse(JSON.parse(result.text));
      const report: SpecialistReport = { agent: name, role, ...advice };
      onReport(report);
      record({
        speaker: name,
        kind: "assessment",
        message: "Recommendation: " + advice.recommendation,
      });
      return advice;
    }
  );
}

// Evaluation coverage uses exactly the production specialist prompt and tools.
// It does not alter the Director's adaptive consultation policy.
export async function collectSpecialistAssessment(
  state: MissionState,
  name: import("./mission-team.js").SpecialistName,
  question: string
) {
  const current = investigationFor(state.missionId) ?? createInvestigation(state.missionId);
  const specialty = Object.values(specialties).find((item) => item.name === name)!;
  const budget = new InvestigationBudget(undefined, () => current.usage.summary());
  current.api.budget = budget;
  try {
    current.mcp = await connectMissionMcp(state);
    return await assessSpecialist(
      current,
      state,
      specialty,
      question,
      () => {},
      () => {}
    );
  } finally {
    budget.finish();
    current.api.budget = undefined;
    await current.mcp?.close();
    current.mcp = undefined;
  }
}

export async function runMissionDirector(
  state: MissionState,
  onActivity?: (entry: CouncilLog) => void,
  onReport?: ReportActivity,
  reviewRequest?: string
) {
  const log: CouncilLog[] = [];
  const reports = new Map<string, SpecialistReport>();
  const unavailable = new Set<string>();
  const incompleteMessage = () =>
    "Assessment incomplete: unavailable requested specialists: " +
    [...unavailable].join(", ") +
    ". No proposal is allowed; reassessment requires an explicit commander request.";
  const record: CouncilActivity = (entry) => {
    const item = { id: "council-" + randomUUID(), ...entry };
    log.push(item);
    onActivity?.(item);
  };
  const recordReport: ReportActivity = (report) => {
    reports.set(report.agent, report);
    onReport?.(report);
  };
  if (!process.env.OPENAI_API_KEY)
    throw new Error("Configure OPENAI_API_KEY before requesting a mission assessment.");
  let current = investigationFor(state.missionId) ?? createInvestigation(state.missionId);
  if (current.legacyEvidence) {
    const usage = current.usage.snapshot();
    await clearMissionSession(state.missionId);
    current = createInvestigation(state.missionId);
    current.usage.restore(usage);
  }
  const budget = new InvestigationBudget(undefined, () => current.usage.summary());
  current.api.budget = budget;
  try {
    budget.check();
    if (current.restored && !current.pending) {
      // Reassessment is a new explicit user request. Cancel an interrupted turn
      // before adding input, retaining each role's prior conversation.
      await Promise.all(current.sessions.all().map((ref) => current.api.cancel(ref)));
    }
    current.restored = false;
    // Superseded proposals are cancelled before follow-up input starts a new turn.
    if (current.pending) {
      const previous = current.pending;
      current.pending = undefined;
      await current.api.resume(
        current.director,
        toolError(
          previous.call,
          "This proposal was superseded by a commander review. Stop this turn without any further tool calls."
        ),
        async (call) =>
          toolError(call, "This turn is superseded. Stop and wait for the next commander request.")
      );
    }
    await current.mcp?.close();
    current.mcp = await connectMissionMcp(state);
    budget.controller.signal.addEventListener(
      "abort",
      () => {
        void current.mcp?.close().catch(() => {});
      },
      { once: true }
    );
    record({
      speaker: "Mission Director",
      kind: "director",
      message: reviewRequest
        ? "Received the commander’s review request and is reassessing the proposal."
        : "Started an adaptive investigation and will consult specialists to reduce risk.",
    });
    const consult = async (
      specialty: (typeof specialties)[keyof typeof specialties],
      question: string
    ) => {
      if (unavailable.has(specialty.name))
        return {
          available: false,
          error: "Unavailable assessment: " + specialty.name + ". No retry in this assessment.",
        };
      if (unavailable.size) return { available: false, error: incompleteMessage() };
      record({
        speaker: "Mission Director",
        kind: "api",
        message: "Asked " + specialty.name + " for an assessment.",
      });
      try {
        return await assessSpecialist(current, state, specialty, question, record, recordReport);
      } catch (error) {
        if (!(error instanceof ConsultationTimeoutError)) throw error;
        budget.check();
        unavailable.add(specialty.name);
        reports.delete(specialty.name);
        const message = "Unavailable assessment: " + specialty.name + ". " + error.message;
        record({ speaker: specialty.name, kind: "assessment", message });
        return { available: false, error: message };
      }
    };
    const handleTool = async (call: FunctionCall): Promise<ToolResult | null> => {
      if (call.name === "consult_specialists") {
        if (unavailable.size) return toolError(call, incompleteMessage());
        const batch = parseBatchConsultations(parseArguments(call));
        if (!batch.success)
          return toolError(call, "Provide two to four distinct specialists, each with a question.");
        budget.consult(batch.data.consultations.length);
        record({
          speaker: "Mission Director",
          kind: "api",
          message:
            "Requested concurrent assessments from " +
            batch.data.consultations.map((entry) => entry.specialist).join(", ") +
            ".",
        });
        const results = await Promise.allSettled(
          batch.data.consultations.map(async (entry) => {
            const specialty = Object.values(specialties).find(
              (candidate) => candidate.name === entry.specialist
            )!;
            return { agent: specialty.name, ...(await consult(specialty, entry.question)) };
          })
        );
        // Drain every consultation before propagating an error. Session/MCP
        // cleanup must never race a specialist still using those resources.
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
        return toolResult(
          call,
          results.map((result) => {
            if (result.status !== "fulfilled") throw new Error("Assessment did not complete.");
            return result.value;
          })
        );
      }
      if (call.name === "submit_mission_plan") {
        if (unavailable.size) throw new Error(incompleteMessage());
        if (!reports.size)
          return toolError(
            call,
            "Consult at least one specialist for fresh evidence before submitting a plan."
          );
        try {
          const plan = validateMissionPlan(state, parseArguments(call));
          current.pending = { id: randomUUID(), call, plan };
          checkpointInvestigation(state.missionId);
          record({
            speaker: "Mission Director",
            kind: "api",
            message:
              "Submitted the proposed response for commander review. No mission action has been taken.",
          });
          return null;
        } catch (error) {
          budget.invalidProposal();
          record({
            speaker: "Mission Director",
            kind: "api",
            message:
              "The proposed response contains an invalid or unavailable command and needs revision.",
          });
          return toolError(call, planValidationFeedback(error));
        }
      }
      const specialty = specialties[call.name as keyof typeof specialties];
      if (!specialty) return toolError(call, "Unknown mission function.");
      const question = questionSchema.safeParse(parseArguments(call));
      if (!question.success)
        return toolError(call, "Provide a non-empty question for the specialist.");
      budget.consult();
      const advice = await consult(specialty, question.data.question);
      if ("available" in advice) return toolError(call, advice.error);
      return toolResult(call, advice);
    };
    const input = missionDirectorInput(state, reviewRequest);
    const profile = agentProfiles["Mission Director"];
    let result = await traceMissionOperation(
      "mission.assessment",
      { "openinference.span.kind": "AGENT", "llm.model_name": profile.model },
      () =>
        current.sessions.run(
          "Mission Director",
          {
            model: profile.model,
            reasoning: { effort: profile.reasoningEffort },
            instructions: directorInstructions(),
            tools: [
              functionTool(
                "consult_specialists",
                "Consult two to four distinct specialists concurrently on independent questions. Waits for every report before returning. Use individual tools for dependent follow-ups.",
                batchConsultationSchema
              ),
              ...Object.entries(specialties).map(([name, value]) =>
                functionTool(name, value.description, questionSchema)
              ),
              functionTool(
                "submit_mission_plan",
                "Submit a proposal and wait for commander authorization. This does not execute any mission action.",
                decisionPlanSchema
              ),
            ],
            text: structuredText(decisionPlanSchema),
          },
          input,
          handleTool
        )
    );
    if (unavailable.size) throw new Error(incompleteMessage());
    if (!result.pending) {
      // A final draft is not authorization-ready. One explicit follow-up can
      // recover an omitted submission without approving anything implicitly.
      record({
        speaker: "Mission Director",
        kind: "api",
        message: "Prepared a draft and is submitting it for commander review.",
      });
      result = await current.api.send(
        current.director,
        "The previous turn ended with a draft but no pending authorization call. Call submit_mission_plan now with a plan based on the evidence already collected; do not consult more specialists. Draft: " +
          result.text,
        handleTool
      );
    }
    const pending = investigationFor(state.missionId)?.pending;
    if (!result.pending || !pending)
      throw new Error(
        "The Director finished without requesting commander authorization. Reassess the incident."
      );
    const usage = await collectUsage(current);
    budget.check();
    return {
      log,
      reports: [...reports.values()],
      plan: structuredClone(pending.plan),
      proposalId: pending.id,
      awaitingApproval: true,
      investigation: budget.finish(),
      usage,
    };
  } catch (error) {
    current.api.budget = undefined;
    // Cancel work on failure, retaining completed conversations for reassessment.
    current.pending = undefined;
    await Promise.allSettled(current.sessions.all().map((ref) => current.api.cancel(ref)));
    current.restored = true;
    checkpointInvestigation(state.missionId);
    throw new InvestigationError(error, budget.finish(), current.usage.summary());
  } finally {
    budget.finish();
    current.api.budget = undefined;
    await current.mcp?.close();
    current.mcp = undefined;
    checkpointInvestigation(state.missionId);
  }
}

export async function resolveMissionApproval(
  state: MissionState,
  approved: boolean,
  proposalId: string
) {
  const current = investigationFor(state.missionId);
  const pending = current?.pending;
  if (!current || !pending || pending.id !== proposalId)
    throw new Error("This mission proposal is no longer awaiting authorization.");
  if (
    JSON.stringify(pending.plan) !== JSON.stringify(validateMissionPlan(state, state.selectedPlan))
  )
    throw new Error("The displayed mission proposal does not match the pending tool call.");
  // A submitted decision cannot be clicked twice, even when its observer fails.
  current.pending = undefined;
  checkpointInvestigation(state.missionId);
  const budget = new InvestigationBudget(undefined, () => current.usage.summary());
  current.api.budget = budget;
  const result = approved
    ? toolResult(pending.call, { status: "authorized_submission", plan: pending.plan })
    : toolError(
        pending.call,
        "The commander declined this proposal. Stop now without further tools. No actions are authorized."
      );
  try {
    const completion = await traceMissionOperation(
      "mission.authorization",
      { "openinference.span.kind": "CHAIN", approved },
      () =>
        current.api.resume(current.director, result, async (call) =>
          toolError(
            call,
            "The commander decision is final for this proposal. Stop without further tool calls."
          )
        )
    );
    if (approved) validateAuthorizedPlan(state, pending.plan, JSON.parse(completion.text));
    const usage = await collectUsage(current);
    checkpointInvestigation(state.missionId);
    return {
      plan: structuredClone(pending.plan),
      awaitingApproval: false,
      usage,
    };
  } catch (error) {
    current.api.budget = undefined;
    await Promise.allSettled(current.sessions.all().map((ref) => current.api.cancel(ref)));
    current.restored = true;
    checkpointInvestigation(state.missionId);
    throw new InvestigationError(error, budget.finish(), current.usage.summary());
  } finally {
    budget.finish();
    current.api.budget = undefined;
  }
}
