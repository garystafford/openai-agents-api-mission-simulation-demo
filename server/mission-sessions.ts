import type { SessionCreateParams } from "openai/resources/beta/agents/sessions/sessions";
import { agentProfiles, type AgentProfileName } from "./agent-profiles.js";
import type { AgentsApi, SessionRef } from "./agents-api.js";
import { specialistName } from "./mission-team.js";
import { recordAgentRun } from "./agent-recording.js";

// One registry belongs to one mission. Different roles can work concurrently;
// turns for the same role are queued to preserve its conversation ordering.
export class MissionSessions {
  private readonly refs = new Map<AgentProfileName, SessionRef>();
  private readonly inFlight = new Map<AgentProfileName, Promise<unknown>>();

  constructor(
    private readonly missionId: string,
    private readonly api: Pick<AgentsApi, "start" | "send">,
    initial: SessionRef[] = []
  ) {
    for (const ref of initial) {
      if (!ref.role) continue;
      const role = specialistName(ref.role);
      if (role in agentProfiles) {
        ref.role = role;
        this.refs.set(role as AgentProfileName, ref);
      }
    }
  }

  ref(name: AgentProfileName): SessionRef {
    let ref = this.refs.get(name);
    if (!ref) {
      ref = {
        model: agentProfiles[name].model,
        role: name,
        missionId: this.missionId,
        results: new Map(),
      };
      this.refs.set(name, ref);
    }
    return ref;
  }

  all() {
    return [...this.refs.values()];
  }

  run(
    name: AgentProfileName,
    agent: SessionCreateParams.Agent,
    input: string,
    handleTool: Parameters<AgentsApi["start"]>[3]
  ) {
    const previous = this.inFlight.get(name) ?? Promise.resolve();
    const operation = previous.then(() => {
      const ref = this.ref(name);
      return recordAgentRun(name, ref, agent, input, handleTool, (handler) =>
        ref.id ? this.api.send(ref, input, handler) : this.api.start(ref, agent, input, handler)
      );
    });
    this.inFlight.set(name, operation);
    return operation.finally(() => {
      if (this.inFlight.get(name) === operation) this.inFlight.delete(name);
    });
  }
}
