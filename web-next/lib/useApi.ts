"use client";

import { useEffect, useState } from "react";

export type ApiState<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

// Runs a fetcher on mount, and again whenever `attempt` changes (a "Try again" button increments it). Failures land in
// state so the screen can show them; they are also logged.
export function useApi<T>(fetcher: () => Promise<T>, attempt = 0): ApiState<T> {
  const [state, setState] = useState<{ attempt: number; value: ApiState<T> }>({ attempt, value: { status: "loading" } });
  useEffect(() => {
    let live = true;
    fetcher().then(
      (data) => live && setState({ attempt, value: { status: "ready", data } }),
      (err: unknown) => {
        console.error(err);
        if (live) setState({ attempt, value: { status: "error", message: err instanceof Error ? err.message : String(err) } });
      },
    );
    return () => {
      live = false;
    };
    // The fetcher is a module-level function; running it once per mount and per attempt is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);
  // A new attempt shows "loading" at once, before its effect has run.
  return state.attempt === attempt ? state.value : { status: "loading" };
}
