import { missionTeam } from "../../server/mission-team.js";

export function MissionOverview({
  showOverview,
  showTeam,
  onCloseOverview,
  onCloseTeam,
  profileLabel,
}: {
  showOverview: boolean;
  showTeam: boolean;
  onCloseOverview: () => void;
  onCloseTeam: () => void;
  profileLabel: (name: string) => string;
}) {
  return (
    <>
      {showOverview && (
        <div className="modal-backdrop" onMouseDown={onCloseOverview}>
          <section
            className="technical-overview"
            role="dialog"
            aria-modal="true"
            aria-labelledby="technical-overview-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Technical overview</p>
                <h2 id="technical-overview-title">
                  How this mission demonstrates the OpenAI Agents API
                </h2>
              </div>
              <button
                className="modal-close"
                onClick={onCloseOverview}
                aria-label="Close technical overview"
              >
                ×
              </button>
            </div>
            <p className="overview-intro">
              The OpenAI Agents API runs the Mission Director and specialist sessions. The
              surrounding application owns the simulated command, authorization boundary, and
              simulated effects and measured outcomes.
            </p>
            <div className="overview-grid">
              <article>
                <h3>Multi-agent delegation</h3>
                <p>
                  The Mission Director coordinates Power & Thermal, Life Support, Weather &
                  Navigation, and Risk Review, the specialists consulted through application
                  function tools. Each selected specialist runs in its own Agents API session with a
                  role-specific GPT-6 profile. Sessions begin on demand and are reused throughout
                  the mission. Independent assessments can run concurrently; dependent follow-ups
                  build on earlier reports.
                </p>
              </article>
              <article>
                <h3>Role-specific agents and models</h3>
                <p>
                  Each session has focused instructions, its own tool access, and a configurable
                  model and reasoning-effort profile. The command-structure panel shows the active
                  non-secret profiles for this run.
                </p>
              </article>
              <article>
                <h3>Mission Control MCP</h3>
                <p>
                  Specialists access telemetry, protocol lookup, and current simulated cross-checks
                  through an application function bridge to the local stdio MCP server. The Director
                  chooses which specialists need that evidence for each incident.
                </p>
              </article>
              <article>
                <h3>Structured outputs</h3>
                <p>
                  Specialist advice and the Director’s proposal use typed schemas. The plan includes
                  actions, rationale, remaining uncertainty, and approval scope before the server
                  checks its structure and available capabilities. Success is measured after
                  execution.
                </p>
              </article>
              <article>
                <h3>Session-backed reassessment</h3>
                <p>
                  The Director and specialists retain their earlier findings across consultations
                  and commander reviews within the same mission. Specialists refresh their evidence
                  before advising again. Starting a new incident clears that context.
                </p>
              </article>
              <article>
                <h3>Observable run activity</h3>
                <p>
                  The application streams selected Agents API activity over server-sent events:
                  delegation, MCP tool calls, approvals, and structured specialist submissions. It
                  intentionally does not expose private model reasoning.
                </p>
              </article>
              <article>
                <h3>Mission usage and cost</h3>
                <p>
                  API turn usage is accumulated across the Director, specialists, reassessment, and
                  approval resume. Counts are provisional while accounting arrives. The Mission
                  Record separates input, cached input, reasoning, and visible output tokens, then
                  estimates direct-API cost by model.
                </p>
              </article>
              <article>
                <h3>Guardrails and human authorization</h3>
                <p>
                  Server validation checks proposal structure and available capabilities. The
                  application withholds the result of <code>submit_mission_plan</code> until the
                  commander decides, then resumes the same API turn. Authorization applies to one
                  immutable proposal.
                </p>
              </article>
              <article>
                <h3>Tracing and evaluation</h3>
                <p>
                  The OpenAI dashboard records hosted agent traces. Optional Phoenix application
                  spans cover assessments, specialist sessions, MCP tools, and authorization. Local
                  evaluations verify scenario, authorization, and outcome behavior.
                </p>
              </article>
            </div>
            <p className="overview-footnote">
              For the platform concepts behind this design, see the{" "}
              <a
                href="https://developers.openai.com/api/docs/guides/agents-api/overview"
                target="_blank"
                rel="noreferrer"
              >
                OpenAI Agents API guide
              </a>
              .
            </p>
          </section>
        </div>
      )}
      {showTeam && (
        <div className="modal-backdrop" onMouseDown={onCloseTeam}>
          <section
            className="technical-overview team-overview"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mission-team-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Mission team</p>
                <h2 id="mission-team-title">Command structure</h2>
              </div>
              <button className="modal-close" onClick={onCloseTeam} aria-label="Close mission team">
                ×
              </button>
            </div>
            <p className="overview-intro">
              The Mission Director owns the recommendation and chooses specialists according to the
              incident. Each specialist independently investigates one domain, then returns evidence
              and a trade-off for the Director to reconcile.
            </p>
            <div className="team-structure">
              <article className="director-card">
                <div>
                  <span className="director-name">Mission Director</span>
                  <small>Command coordination · {profileLabel("Mission Director")}</small>
                </div>
                <span className="role-tag">SYNTHESIZES</span>
                <p>
                  Coordinates the specialists, resolves conflicting advice, and prepares one
                  recommendation. The Director cannot execute a command.
                </p>
              </article>
              <div className="reporting-line">
                <span>Delegates only the questions that matter</span>
              </div>
              <div className="specialist-grid">
                {missionTeam.map((member) => (
                  <article className="team-member" key={member.name}>
                    <span>{member.name}</span>
                    <small>{profileLabel(member.name)}</small>
                    <p>{member.focus}</p>
                  </article>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
