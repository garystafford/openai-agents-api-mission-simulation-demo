import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { actionCapabilities } from "./simulation.js";
import type { MissionAction } from "./mission-contract.js";

import {
  telemetryForSystem,
  verificationReport,
  type MissionMcpContext,
} from "./mission-evidence.js";

import { arithmeticDescription, arithmeticSchema, checkArithmetic } from "./mission-arithmetic.js";

function missionContext(): MissionMcpContext {
  const source = process.env.MISSION_MCP_CONTEXT;
  if (!source) throw new Error("MISSION_MCP_CONTEXT is required.");
  return JSON.parse(source) as MissionMcpContext;
}

const context = missionContext();
const server = new McpServer({ name: "ares-7-mission-control", version: "1.0.0" });

server.registerTool(
  "mcp_read_mission_telemetry",
  {
    description:
      "Read current Ares-7 telemetry, simulated sample times, recent readings and trends. Includes measured objectives and execution results. Use this before making a recommendation.",
    inputSchema: {
      system: z
        .string()
        .describe(
          "'power' (or 'electrical') returns battery, loads, charging, endurance and relay draw; 'all' returns all readings. Other names match reading labels; no match returns all readings."
        ),
    },
  },
  async ({ system }) => {
    const readings = telemetryForSystem(context, system);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            readings: readings.length ? readings : context.telemetry,
            minutesToImpact: context.minutesToImpact,
            elapsedMinutes: context.elapsedMinutes,
            objectives: context.objectives,
            execution: context.commands,
            rules: context.rules,
            responseWindow: context.responseWindow,
            authorization: context.authorization,
            recallPrerequisites: context.recallPrerequisites,
          }),
        },
      ],
    };
  }
);

server.registerTool(
  "mcp_query_mission_protocol",
  {
    description: "Look up a mission safety protocol by topic.",
    inputSchema: { topic: z.string() },
  },
  async ({ topic }) => ({
    content: [
      {
        type: "text",
        text: [
          "Scenario: " + context.scenario.title + ".",
          "Protocol principle: protect crew and life-critical capability before research or convenience loads.",
          "Exact response interval: " + JSON.stringify(context.responseWindow) + ".",
          "This incident's recall prerequisites: " +
            JSON.stringify(context.recallPrerequisites) +
            ". These explicit thresholds override guesses from a rover mentioned in telemetry.",
          "Authorization contract: " + JSON.stringify(context.authorization) + ".",
          "Available actions: " + context.scenario.availableActions.join(", ") + ".",
          "Action capabilities, durations and prerequisites: " +
            JSON.stringify(
              Object.fromEntries(
                context.scenario.availableActions.map((action) => [
                  action,
                  actionCapabilities[action as MissionAction],
                ])
              )
            ),
          "Simulation units: electrical load and solar charge are battery percentage points per minute. Coolant leakage is percentage points per minute. Action effects and diagnostic thresholds are simplified training rules, not real spacecraft physics. Telemetry timestamps are elapsed simulated minutes, not wall-clock time; trends describe numerical direction, not whether the system is safe. Radiation dose is cumulative and shelter attenuates exposure without reducing external radiation.",
          "Execution semantics: authorized commands start together, use elapsed-time action durations and resource rates, and wait for modeled prerequisites. Action list order does not create a sequential schedule. A baseline has only one sample; additional lookups do not advance time or manufacture earlier history.",
          "Current simulator rules: " + JSON.stringify(context.rules) + ".",
          "Requested topic: " + topic + ".",
        ].join(" "),
      },
    ],
  })
);

server.registerTool(
  "mcp_request_independent_verification",
  {
    description:
      "Read a current simulated orbital, maintenance, or crew cross-check. Reports share the simulator observation sources; they are not independent physical sensors.",
    inputSchema: { source: z.enum(["orbital", "maintenance", "crew"]) },
  },
  async ({ source }) => ({
    content: [{ type: "text", text: JSON.stringify(verificationReport(context, source)) }],
  })
);

server.registerTool(
  "mcp_check_arithmetic",
  { description: arithmeticDescription, inputSchema: arithmeticSchema.shape },
  async (input) => ({ content: [{ type: "text", text: JSON.stringify(checkArithmetic(input)) }] })
);

await server.connect(new StdioServerTransport());
