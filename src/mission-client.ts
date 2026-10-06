import type { AssessmentEvent, MissionResponse } from "../server/mission-contract.js";
import { legacySpecialistNames, specialistName } from "../server/mission-team.js";

const oldNames = new RegExp("\\b(" + Object.keys(legacySpecialistNames).join("|") + ")\\b", "g");

// Presentation only: saved proposals, authorizations, and audit exports retain their exact text.
export function displaySpecialistNames<T>(value: T): T {
  if (typeof value === "string") return value.replace(oldNames, specialistName) as T;
  if (Array.isArray(value)) {
    const items = value.map(displaySpecialistNames);
    return (items.every((item, index) => item === value[index]) ? value : items) as T;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const name = specialistName(key);
      const displayed = /(^id$|Id$|^seed$)/.test(key) ? item : displaySpecialistNames(item);
      changed ||= name !== key || displayed !== item;
      return [name, displayed];
    });
    return changed ? (Object.fromEntries(entries) as T) : value;
  }
  return value;
}

async function responseError(response: Response) {
  const body = await response.json().catch(() => ({}));
  return new Error(typeof body.error === "string" ? body.error : "Mission control link failed.");
}

export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(path, {
    method,
    signal,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await responseError(response);
  return displaySpecialistNames(await response.json()) as T;
}

export function applyAssessmentEvent(
  mission: MissionResponse,
  event: AssessmentEvent
): MissionResponse {
  event = displaySpecialistNames(event);
  switch (event.type) {
    case "activity":
      return {
        ...mission,
        councilLog: [
          ...mission.councilLog.filter((entry) => entry.id !== event.entry.id),
          event.entry,
        ],
      };
    case "report":
      return {
        ...mission,
        reports: [
          ...mission.reports.filter((report) => report.agent !== event.report.agent),
          event.report,
        ],
      };
    case "complete":
      return event.state;
    case "error":
      return mission;
  }
}

// An observer owns only its reader. Closing the page never cancels the server's investigation.
export async function readAssessmentEvents(
  response: Response,
  receive: (event: AssessmentEvent) => void
) {
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new Error("The mission team link could not be opened.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const packet = (value: string) => {
    const data = value
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (data) receive(JSON.parse(data) as AssessmentEvent);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        packet(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
      }
      if (done) break;
    }
    if (buffer.trim()) packet(buffer);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function streamAssessment(
  request: string | undefined,
  receive: (event: AssessmentEvent) => void,
  signal?: AbortSignal
) {
  const reviewRequest = request?.trim();
  const response = await fetch("/api/mission/convene", {
    method: "POST",
    signal,
    headers: {
      Accept: "text/event-stream",
      ...(reviewRequest ? { "Content-Type": "application/json" } : {}),
    },
    body: reviewRequest ? JSON.stringify({ reviewRequest }) : undefined,
  });
  await readAssessmentEvents(response, receive);
}
