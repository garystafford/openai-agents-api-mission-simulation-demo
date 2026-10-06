import { ProposalReview } from "./components/ProposalReview.js";
import { IncidentSetup } from "./components/IncidentSetup.js";
import { useEffect, useState } from "react";
import { actionLabels, simulationSpeed, formatSimulationTime } from "../server/mission-contract.js";
import { useMission } from "./useMission.js";
import { AgentMark, Badge } from "./components/AgentMark.js";
import { MissionCost } from "./components/MissionCost.js";
import { InteractionMap } from "./components/InteractionMap.js";
import { MissionClock } from "./components/MissionClock.js";
import { ExecutionControls } from "./components/ExecutionControls.js";
import { MissionOverview } from "./components/MissionOverview.js";

export function App() {
  const { mission, busy, error, refresh, act: mutateMission, conveneCouncil } = useMission();
  const [showOverview, setShowOverview] = useState(false);
  const [showTeam, setShowTeam] = useState(false);
  useEffect(() => {
    if (!showOverview && !showTeam) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowOverview(false);
        setShowTeam(false);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [showOverview, showTeam]);

  async function act(name: string, path: string, body?: unknown) {
    await mutateMission(name, path, body);
  }

  if (!mission)
    return (
      <main className="loading">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button onClick={() => void refresh()}>Reconnect to Mission Control</button>
          </>
        ) : (
          "Booting Ares-7 mission console…"
        )}
      </main>
    );
  const operationRunning = mission.operation?.status === "running";
  const blocked = Boolean(busy) || operationRunning;
  const councilRunning =
    busy === "council" || (operationRunning && mission.operation?.kind === "assessment");
  const profileLabel = (name: string) => {
    const profile = mission.agentProfiles[name];
    return profile
      ? profile.model + " · " + profile.reasoningEffort + " reasoning"
      : "Runtime profile unavailable";
  };
  const pressure = Math.max(0, Math.min(100, (32 - mission.minutesToImpact) * 4));
  const activePlan = mission.selectedPlan ?? null;
  const visibleCouncilLog = mission.councilLog;
  const planPanel = activePlan && (
    <section className="panel brief" aria-label="Director's proposed plan">
      <p className="eyebrow">Director’s recommendation</p>
      <h2>{activePlan.headline}</h2>
      <div className="plan-actions">
        {activePlan.actions.map((action) => (
          <span key={action}>{actionLabels[action] ?? action}</span>
        ))}
      </div>
      <p>{activePlan.rationale}</p>
      {activePlan.uncertainties.length > 0 && (
        <p className="uncertainties">
          <strong>Still uncertain:</strong> {activePlan.uncertainties.join(" · ")}
        </p>
      )}
    </section>
  );
  return (
    <main>
      <header className="topbar">
        <div className="brand-lockup">
          <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
          <div>
            <p className="eyebrow">ARES-7 / MISSION CONTROL</p>
            <h1>{mission.scenario.title}</h1>
            <p className="product-intro">
              You are the commander of Ares-7. Your job is to assess a live incident with specialist
              support, review the proposed response, and authorize the simulation to act.
            </p>
          </div>
        </div>
        <div className="header-meta">
          <span>SOL {mission.sol}</span>
          <button
            className="info-button"
            onClick={() => setShowOverview(true)}
            aria-label="Open technical overview"
            title="How this mission is built"
          >
            i
          </button>
          <button
            className="quiet"
            onClick={() => void act("reset", "/api/mission/reset")}
            disabled={blocked}
          >
            New incident
          </button>
        </div>
      </header>
      <IncidentSetup
        mission={mission}
        blocked={blocked}
        start={(body) => act("reset", "/api/mission/reset", body)}
      />
      <section className="hero">
        <MissionClock mission={mission} />
        <div className="pressure">
          <div className="pressure-head">
            <span>OPERATIONAL PRESSURE</span>
            <strong>{pressure}%</strong>
          </div>
          <div className="meter">
            <i style={{ width: pressure + "%" }} />
          </div>
          <p className="scenario-summary">{mission.scenario.briefing}</p>
          <div className="scenario-risks">
            {mission.scenario.activeRisks.map((risk) => (
              <span key={risk}>{risk}</span>
            ))}
          </div>
        </div>
        <div className="phase">
          <p className="eyebrow">Run state</p>
          <strong>{mission.phase.replaceAll("_", " ")}</strong>
          <span>Session: {mission.missionId}</span>
        </div>
      </section>
      <section className="panel telemetry telemetry-wide">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Live input</p>
            <h2>Telemetry</h2>
          </div>
          <span className="dot live">LIVE</span>
        </div>
        <div className="telemetry-grid">
          {mission.telemetry.map((reading) => (
            <article className="reading" key={reading.label}>
              <div>
                <span>{reading.label}</span>
                <Badge status={reading.status} />
              </div>
              <strong>{reading.value}</strong>
              <p>{reading.detail}</p>
              <div className="reading-observation">
                <span>Sampled at sim T+{formatSimulationTime(reading.sampledAtMinutes ?? 0)}</span>
                {reading.quality === "delayed" && <strong>Delayed observation</strong>}
                <span>
                  {reading.trend === "insufficient_data"
                    ? "Baseline reading"
                    : reading.trend === "rising"
                      ? "↑ Rising"
                      : reading.trend === "falling"
                        ? "↓ Falling"
                        : "→ Steady"}
                </span>
              </div>
              {reading.history && (
                <details className="reading-history">
                  <summary>Recent readings ({reading.history.length})</summary>
                  <ol>
                    {reading.history.map((sample) => (
                      <li key={sample.elapsedMinutes}>
                        <span>T+{formatSimulationTime(sample.elapsedMinutes)}</span>
                        <strong>{sample.value}</strong>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </article>
          ))}
        </div>
      </section>
      {operationRunning && (
        <div className="muted" role="status">
          {mission.operation?.kind === "assessment" ? "Investigation" : "Mission operation"} in
          progress. You can refresh this page without restarting it.
        </div>
      )}
      {mission.investigation && (
        <p className="muted" aria-label="Investigation measurements">
          Latest investigation: {(mission.investigation.elapsedMs / 1000).toFixed(1)} seconds ·{" "}
          {mission.investigation.consultations} specialist consultations ·{" "}
          {mission.investigation.validationRetries} proposal corrections
          {mission.investigation.stopReason ? " · " + mission.investigation.stopReason : ""}
        </p>
      )}
      {error && <div className="error">{error}</div>}

      <MissionOverview
        showOverview={showOverview}
        showTeam={showTeam}
        onCloseOverview={() => setShowOverview(false)}
        onCloseTeam={() => setShowTeam(false)}
        profileLabel={profileLabel}
      />

      <section className="layout">
        <div className="command-column">
          {mission.phase === "assessment" && planPanel}
          <section className="panel next-action">
            {mission.phase === "failed" ? (
              <div className="error">
                <h3>Mission failed</h3>
                <p>{mission.failureReason}</p>
                <p>Start a new incident to try again.</p>
              </div>
            ) : mission.phase === "resolved" ? (
              <>
                <p className="eyebrow">Mission complete</p>
                <h2>
                  {mission.outcome === "stabilized"
                    ? "The incident is contained"
                    : "The habitat remains degraded"}
                </h2>
                <p className="muted">
                  Review the plan, evidence, and event record to see how the selected actions
                  changed the outcome.
                </p>
                <button
                  className="secondary"
                  onClick={() => void act("reset", "/api/mission/reset")}
                  disabled={blocked}
                >
                  Start a new incident
                </button>
              </>
            ) : mission.pendingCommand ? (
              <>
                <p className="eyebrow">Commander authorization required</p>
                <h2>Authorize the proposed actions</h2>
                <p className="muted">
                  The mission team is standing by for your decision. Authorize the proposed actions
                  to begin the response, or decline to return to assessment. Authorization starts
                  accelerated simulation automatically at {simulationSpeed}× speed: one real second
                  represents {simulationSpeed} simulated seconds. You can pause at any time.
                </p>
                <div className="authorization-details">
                  <strong>{mission.pendingCommand.label}</strong>
                  <p>{mission.pendingCommand.consequence}</p>
                </div>
                <div className="button-row">
                  <button
                    onClick={() =>
                      void act("approve", "/api/mission/approve", {
                        approved: true,
                        proposalId: mission.proposalId,
                      })
                    }
                    disabled={blocked}
                  >
                    Authorize plan
                  </button>
                  <button
                    className="danger"
                    onClick={() =>
                      void act("decline", "/api/mission/approve", {
                        approved: false,
                        proposalId: mission.proposalId,
                      })
                    }
                    disabled={blocked}
                  >
                    Decline
                  </button>
                </div>
              </>
            ) : mission.phase === "executing" ? (
              <ExecutionControls mission={mission} blocked={blocked} act={act} />
            ) : mission.outcome === "degraded" && !mission.proposalId ? (
              <>
                <p className="eyebrow">Further intervention needed</p>
                <h2>
                  {mission.replanning?.status === "queued" || councilRunning
                    ? "Developing a revised plan"
                    : "Further intervention needed"}
                </h2>
                {mission.replanning && (
                  <p role="status">
                    {mission.replanning.reason} Automatic replanning attempts:{" "}
                    {mission.replanning.attempts} / 2.{" "}
                    {mission.replanning.status === "limit"
                      ? "Automatic limit reached. Review conditions before requesting another assessment."
                      : "Every revised plan requires your authorization."}
                  </p>
                )}
                <p className="muted">
                  Unresolved:{" "}
                  {mission.objectiveResults
                    .filter((goal) => !goal.met)
                    .map((goal) => goal.label)
                    .join(", ")}
                  . The team can investigate the changed conditions and develop another plan within
                  this mission.
                </p>
                <button
                  onClick={() =>
                    void conveneCouncil(
                      "The previous response did not meet mission objectives. Review updated telemetry and execution results, then propose the next response."
                    )
                  }
                  disabled={blocked}
                >
                  {councilRunning ? "Mission team is reassessing…" : "Reassess this mission"}
                </button>
              </>
            ) : !activePlan ? (
              <>
                <p className="eyebrow">Recommended action</p>
                <h2>Get an adaptive assessment</h2>
                <p className="muted">
                  The Director will decide which specialists and evidence sources are needed for
                  this incident, then return an approval-ready plan.
                </p>
                <button onClick={() => void conveneCouncil()} disabled={blocked}>
                  {councilRunning ? "Mission team is assessing…" : "Get mission team assessment"}
                </button>
              </>
            ) : (
              <ProposalReview
                key={mission.proposalId}
                blocked={blocked}
                authorize={() =>
                  void act("approval", "/api/mission/request-approval", {
                    proposalId: mission.proposalId,
                  })
                }
                ask={conveneCouncil}
              />
            )}
          </section>
          <section className="panel mission-objectives">
            <p className="eyebrow">Measured conditions</p>
            <h2>Mission objectives</h2>
            <p className="muted">
              Targets describe the outcome. The specialists choose how to achieve it.
            </p>
            <ul>
              {mission.objectiveResults.map((goal) => (
                <li key={goal.metric}>
                  <div>
                    <strong>{goal.label}</strong>
                    <small>
                      Target {goal.comparison === "at_least" ? "≥" : "≤"} {goal.target} {goal.unit}
                    </small>
                  </div>
                  <span className={goal.met ? "goal-met" : "goal-unmet"}>
                    {Math.round(goal.actual * 10) / 10} {goal.unit} · {goal.met ? "Met" : "Unmet"}
                  </span>
                </li>
              ))}
            </ul>
            {mission.simulation.commands.length > 0 && (
              <>
                <h3>Execution results</h3>
                <ul>
                  {mission.simulation.commands.map((command) => (
                    <li key={command.action}>
                      <div>
                        <strong>{actionLabels[command.action]}</strong>
                        <small>{command.detail}</small>
                        <small>
                          {formatSimulationTime(command.progressMinutes)} of simulated action work
                        </small>
                      </div>
                      <span>{command.status}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          {mission.phase !== "assessment" && planPanel}
        </div>
        <div className="agent-column">
          {(councilRunning || visibleCouncilLog.length > 0) && (
            <section
              className={"panel council-record" + (councilRunning ? " panel-active" : "")}
              aria-busy={councilRunning}
            >
              <p className="eyebrow">
                {councilRunning ? "Team assessment in progress" : "Team assessment complete"}
              </p>
              <h2>Team activity</h2>
              {visibleCouncilLog.length === 0 ? (
                <p className="muted">The Director is opening the mission channel…</p>
              ) : (
                <ol>
                  {visibleCouncilLog.map((entry) => (
                    <li key={entry.id} className={entry.kind}>
                      <span className="activity-speaker">
                        <AgentMark name={entry.speaker} />
                        {entry.speaker}
                      </span>
                      <p>{entry.message}</p>
                    </li>
                  ))}
                </ol>
              )}
              {councilRunning && (
                <p className="muted">
                  New entries appear as the Director selects evidence and specialists.
                </p>
              )}
            </section>
          )}
          <section className="panel timeline">
            <p className="eyebrow">Mission record</p>
            <h2>Mission events</h2>
            <a href="/api/mission/record" download>
              Download mission record
            </a>
            <ol>
              {mission.timeline
                .slice()
                .reverse()
                .map((event, index) => (
                  <li key={event.time + index}>
                    <time
                      title={
                        event.occurredAt
                          ? new Date(event.occurredAt).toLocaleString()
                          : "Legacy event: wall time unavailable"
                      }
                    >
                      {event.time}
                      {event.occurredAt && (
                        <small>{new Date(event.occurredAt).toLocaleTimeString()}</small>
                      )}
                    </time>
                    <span className={"event-marker " + event.kind} aria-hidden="true" />
                    <div className="timeline-content">
                      <p>{event.event}</p>
                      {event.plan && (
                        <details>
                          <summary>Recorded plan</summary>
                          <p>{event.plan.headline}</p>
                          <p>
                            {event.plan.actions.map((action) => actionLabels[action]).join("; ")}
                          </p>
                          <p>{event.plan.rationale}</p>
                          <p>{event.plan.approvalScope}</p>
                        </details>
                      )}
                    </div>
                  </li>
                ))}
            </ol>
          </section>
          {mission.usage && <MissionCost usage={mission.usage} />}
        </div>
        <aside className="operations-column">
          <InteractionMap
            reports={mission.reports}
            entries={visibleCouncilLog}
            plan={councilRunning ? null : activePlan}
            running={councilRunning}
            onShowTeam={() => setShowTeam(true)}
          />
          <section
            className={"panel assessments-panel" + (councilRunning ? " panel-active" : "")}
            aria-busy={councilRunning}
          >
            <div className="assessment-heading">
              <div>
                <p className="eyebrow">Team output</p>
                <h3>Specialist assessments</h3>
              </div>
              <span>{mission.reports.length}/4 consulted</span>
            </div>
            {mission.reports.length === 0 ? (
              <div className="empty-state">
                {councilRunning
                  ? "The Director is selecting the first specialist and their evidence sources."
                  : "The specialists are ready. The Director will bring in only those whose domain can reduce this incident’s uncertainty."}
              </div>
            ) : (
              <div className="reports">
                {mission.reports.map((report) => (
                  <article className="report" key={report.agent}>
                    <div className="report-title">
                      <div>
                        <span className="agent-name">
                          <AgentMark name={report.agent} />
                          {report.agent}
                        </span>
                        <small>{profileLabel(report.agent)}</small>
                      </div>
                      <Badge status={report.status} />
                    </div>
                    <p>{report.recommendation}</p>
                    <div className="evidence">
                      {report.evidence.map((item) => (
                        <span key={item}>{item}</span>
                      ))}
                    </div>
                    <footer>
                      <span>Confidence {Math.round(report.confidence * 100)}%</span>
                      <span>Trade-off: {report.tradeoff}</span>
                    </footer>
                  </article>
                ))}
              </div>
            )}
          </section>
        </aside>
      </section>
    </main>
  );
}
