import { missionTeam } from "../../server/mission-team.js";

export function Badge({
  status,
}: {
  status: import("../../server/mission-contract.js").SystemStatus;
}) {
  return <span className={"badge " + status}>{status}</span>;
}
export function AgentMark({ name }: { name: string }) {
  const mark =
    name === "Mission Director"
      ? "director"
      : missionTeam.find((member) => member.name === name)?.mark;
  return <i className={"agent-mark mark-" + mark} aria-hidden="true" />;
}
