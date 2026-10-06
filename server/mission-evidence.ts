import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { missionRules } from "./mission-rules.js";
import type { MissionState } from "./mission-contract.js";

export type MissionMcpContext = ReturnType<typeof missionEvidence>;

// System names refer to a group of measurements, not a display-label substring.
export function telemetryForSystem(context: MissionMcpContext, system: string) {
  const name = system.trim().toLowerCase();
  if (name === "all") return context.telemetry;
  const power = new Set([
    "batteryPct",
    "essentialLoad",
    "nonessentialLoad",
    "solarCharge",
    "powerEnduranceMinutes",
    "backupRelayDrawPctPerMinute",
  ]);
  const readings = context.telemetry.filter((item) =>
    name === "power" || name === "electrical"
      ? power.has(item.metric ?? "")
      : item.label.toLowerCase().includes(name)
  );
  return readings.length ? readings : context.telemetry;
}

// Only this projection crosses the model boundary. Simulator internals stay private.
export function missionEvidence(state: MissionState) {
  return {
    rules: missionRules,
    responseWindow: {
      hazardDeadlineMinutes: state.simulation.elapsedMinutes + state.minutesToImpact,
      confirmationStartMinutes: Math.max(
        0,
        state.simulation.elapsedMinutes + state.minutesToImpact - 1
      ),
      confirmationEndMinutes: state.simulation.elapsedMinutes + state.minutesToImpact,
      postDeadlineConfirmationRequired: false,
    },
    authorization: {
      authority: "commander",
      maximumActionsPerProposal: 4,
      authorizeTogether: true,
    },
    recallPrerequisites: {
      appliesWhileCrewOutside: true,
      mobilityAtLeastPct: 50,
      communicationsAtLeastPct: state.simulation.conditions.repairTarget === "rover" ? 80 : 0,
      explicitInitialRecallRequired: true,
    },
    scenario: { title: state.scenario.title, availableActions: state.scenario.availableActions },
    telemetry: structuredClone(state.telemetry),
    minutesToImpact: state.minutesToImpact,
    elapsedMinutes: state.simulation.elapsedMinutes,
    objectives: state.scenario.objectives.map(({ metric, label, comparison, target, unit }) => ({
      metric,
      label,
      comparison,
      target,
      unit,
      observed: state.telemetry.find((reading) => reading.metric === metric)?.numericValue ?? null,
    })),
    commands: structuredClone(state.simulation.commands),
  };
}

export function verificationReport(
  context: MissionMcpContext,
  source: "orbital" | "maintenance" | "crew"
) {
  const match = {
    orbital: /storm|solar|radiation|relay|communications/i,
    maintenance:
      /coolant|thermal|temperature|recycler|oxygen|carbon|pressure|drone|mobility|slip|motor|electrical|battery/i,
    crew: /crew|distance|communications|shelter/i,
  }[source];
  return {
    source,
    verifiedAtMinutes: context.elapsedMinutes,
    readings: context.telemetry.filter((reading) => match.test(reading.label)),
    execution: context.commands,
    limitation:
      "Simulated cross-check of current observations; not an independent physical sensor. Missing or delayed observations remain uncertain. No lookup advances mission time.",
  };
}

export async function connectMissionMcp(state: MissionState) {
  const ts = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL("./mission-mcp" + (ts ? ".ts" : ".js"), import.meta.url));
  const mcp = new Client({ name: "ares-7-agents-api-bridge", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ts ? ["--import", "tsx", entry] : [entry],
    cwd: process.cwd(),
    env: {
      MISSION_MCP_CONTEXT: JSON.stringify(missionEvidence(state)),
    },
  });
  try {
    await mcp.connect(transport);
    return mcp;
  } catch (error) {
    await transport.close();
    throw error;
  }
}
