import type {
  DecisionPlan,
  CouncilLog as CouncilEntry,
  SpecialistReport as Report,
} from "../../server/mission-contract.js";
import { missionTeam } from "../../server/mission-team.js";
import { AgentMark } from "./AgentMark.js";

export function InteractionMap({
  reports,
  entries,
  plan,
  running,
  onShowTeam,
}: {
  reports: Report[];
  entries: CouncilEntry[];
  plan: DecisionPlan | null;
  running: boolean;
  onShowTeam: () => void;
}) {
  const selected = missionTeam.filter((member) =>
    reports.some((report) => report.agent === member.name)
  );
  const evidenceCount = (agent: string) =>
    entries.filter((entry) => entry.speaker === agent && entry.kind === "evidence").length;
  const state = running ? "Live" : plan ? "Complete" : "Waiting";
  return (
    <section
      className={"panel interaction-map" + (running ? " panel-active" : "")}
      aria-label="Agent interaction flow"
      aria-busy={running}
    >
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Run map</p>
          <h2>Agent interaction flow</h2>
        </div>
        <div className="map-heading-actions">
          <button
            className="info-button"
            onClick={onShowTeam}
            aria-label="View mission team and model profiles"
            title="View mission team and model profiles"
          >
            i
          </button>
          <span className={"flow-state " + state.toLowerCase()}>{state}</span>
        </div>
      </div>
      <div className="flow-director">
        <span>
          <AgentMark name="Mission Director" />
          Mission Director
        </span>
        <small>selects specialists and owns the plan</small>
      </div>
      <div className="flow-connector" aria-hidden="true" />
      {selected.length === 0 ? (
        <div className="flow-empty">
          Run an assessment to see the Director’s actual delegation path.
        </div>
      ) : (
        <div className="flow-specialists" data-count={selected.length}>
          {selected.map((member) => (
            <div className="flow-specialist" key={member.name}>
              <span>
                <AgentMark name={member.name} />
                {member.name}
              </span>
              <em>
                {evidenceCount(member.name)} evidence{" "}
                {evidenceCount(member.name) === 1 ? "request" : "requests"}
              </em>
            </div>
          ))}
        </div>
      )}
      {(selected.length > 0 || plan) && (
        <>
          <div className="flow-connector converge" aria-hidden="true" />
          <div className={"flow-plan " + (plan ? "ready" : "pending")}>
            <span>{plan ? "Approval-ready plan" : "Synthesizing evidence"}</span>
            <small>
              {plan ? plan.actions.length + " proposed actions" : "awaiting specialist output"}
            </small>
          </div>
        </>
      )}
    </section>
  );
}
