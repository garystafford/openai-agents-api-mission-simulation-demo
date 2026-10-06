import { useCallback, useEffect, useRef, useState } from "react";
import { executionIntervalMs, type MissionResponse } from "../server/mission-contract.js";
import { api, applyAssessmentEvent, streamAssessment } from "./mission-client.js";

export function useMission() {
  const [mission, setMission] = useState<MissionResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const activeOperation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await api<MissionResponse>("/api/mission", "GET", undefined, signal);
      if (!mounted.current || signal?.aborted) return;
      setMission(next);
      setError(next.operation?.message ?? "");
      return next;
    } catch (cause) {
      if (mounted.current && !signal?.aborted)
        setError(cause instanceof Error ? cause.message : "Mission control link failed.");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    const loading = api<MissionResponse>("/api/mission", "GET", undefined, controller.signal);
    void loading
      .then((next) => {
        if (controller.signal.aborted) return;
        setMission(next);
        setError(next.operation?.message ?? "");
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Mission control link failed.");
      });
    return () => {
      mounted.current = false;
      controller.abort();
      activeOperation.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    if (
      (mission?.operation?.status !== "running" &&
        mission?.phase !== "executing" &&
        mission?.replanning?.status !== "queued") ||
      busy
    )
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // Observe the server clock or reattach to model work. Live assessment streams own their updates.
    const poll = async () => {
      await refresh(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), executionIntervalMs);
    };
    timer = setTimeout(() => void poll(), executionIntervalMs);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [mission?.operation?.status, mission?.phase, mission?.replanning?.status, busy, refresh]);

  async function perform(name: string, work: (signal: AbortSignal) => Promise<void>) {
    if (activeOperation.current || mission?.operation?.status === "running") return;
    const controller = new AbortController();
    activeOperation.current = controller;
    setBusy(name);
    setError("");
    try {
      await work(controller.signal);
    } catch (cause) {
      if (!controller.signal.aborted) {
        await refresh(controller.signal);
        if (mounted.current)
          setError(cause instanceof Error ? cause.message : "Unexpected console fault.");
      }
    } finally {
      activeOperation.current = null;
      if (mounted.current) setBusy(null);
    }
  }

  async function act(name: string, path: string, body?: unknown) {
    let next: MissionResponse | undefined;
    await perform(name, async (signal) => {
      next = await api<MissionResponse>(path, "POST", body, signal);
      if (mounted.current) setMission(next);
    });
    return next;
  }

  async function conveneCouncil(request?: string) {
    await perform("council", async (signal) => {
      setMission((current) =>
        current
          ? {
              ...current,
              phase: "assessment",
              reports: [],
              councilLog: [],
              selectedPlan: undefined,
              pendingCommand: undefined,
              proposalId: undefined,
            }
          : current
      );
      await streamAssessment(
        request,
        (event) => {
          if (signal.aborted) return;
          if (event.type === "error") throw new Error(event.message);
          setMission((current) => (current ? applyAssessmentEvent(current, event) : current));
        },
        signal
      );
      // Reconcile even after an early stream end. Running work reattaches through polling.
      await refresh(signal);
    });
  }

  return { mission, busy, error, refresh, act, conveneCouncil };
}
