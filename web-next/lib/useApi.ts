"use client";

import { useEffect, useState } from "react";

export type ApiState<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

// Runs a fetcher once on mount. Failures land in state so the screen can show them; they are also logged.
export function useApi<T>(fetcher: () => Promise<T>): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({ status: "loading" });
  useEffect(() => {
    let live = true;
    fetcher().then(
      (data) => live && setState({ status: "ready", data }),
      (err: unknown) => {
        console.error(err);
        if (live) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      },
    );
    return () => {
      live = false;
    };
    // The fetcher is a module-level function; running it once per mount is the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return state;
}
