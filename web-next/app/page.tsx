"use client";

import { useCallback, useEffect, useState } from "react";
import Screen1 from "./screens/Screen1";
import Screen2 from "./screens/Screen2";
import Screen3 from "./screens/Screen3";
import Screen4 from "./screens/Screen4";
import Screen5 from "./screens/Screen5";
import Screen6 from "./screens/Screen6";
import Screen7 from "./screens/Screen7";

const STEPS = [
  { title: "The rules", Screen: Screen1 },
  { title: "Compared", Screen: Screen2 },
  { title: "Why flagged", Screen: Screen3 },
  { title: "Ask why", Screen: Screen4 },
  { title: "Caught", Screen: Screen5 },
  { title: "Tested", Screen: Screen6 },
  { title: "Decide", Screen: Screen7 },
];

// The step lives in the URL hash (#1..#7) so a screen can be opened directly.
function stepFromHash(): number {
  const n = Number(window.location.hash.slice(1));
  return Number.isInteger(n) && n >= 1 && n <= STEPS.length ? n - 1 : 0;
}

export default function Home() {
  const [step, setStep] = useState<number | null>(null);

  const go = useCallback((next: number) => {
    const clamped = Math.min(Math.max(next, 0), STEPS.length - 1);
    window.location.hash = String(clamped + 1);
  }, []);

  useEffect(() => {
    const sync = () => setStep(stepFromHash());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowRight") go(step + 1);
      if (e.key === "ArrowLeft") go(step - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, go]);

  if (step === null) return null;
  const { Screen } = STEPS[step];

  return (
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col px-10 py-8">
      <nav aria-label="Demo steps" className="flex items-center gap-6">
        <ol className="flex flex-1 items-center gap-2">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <button
                type="button"
                onClick={() => go(i)}
                aria-current={i === step ? "step" : undefined}
                className={`flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors duration-150 ${
                  i === step ? "text-ink" : "text-muted hover:text-ink"
                }`}
              >
                <span
                  aria-hidden
                  className={`h-2 w-2 rounded-full ${i === step ? "bg-ink" : i < step ? "bg-muted" : "bg-line"}`}
                />
                <span className={i === step ? "font-medium" : ""}>{s.title}</span>
              </button>
            </li>
          ))}
        </ol>
        <span className="text-sm tabular-nums text-muted">
          {step + 1} / {STEPS.length}
        </span>
      </nav>

      <div className="mt-10 flex flex-1 flex-col">
        <Screen key={step} />
      </div>

      <footer className="mt-8 flex items-center justify-between border-t border-line pt-5">
        <button
          type="button"
          onClick={() => go(step - 1)}
          disabled={step === 0}
          className="rounded-md px-4 py-2 text-ink transition-colors duration-150 hover:bg-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:invisible"
        >
          Back
        </button>
        <span className="text-sm text-muted">Arrow keys move between steps</span>
        <button
          type="button"
          onClick={() => go(step + 1)}
          disabled={step === STEPS.length - 1}
          className="rounded-md bg-ink px-5 py-2 text-paper transition-opacity duration-150 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:invisible"
        >
          Next
        </button>
      </footer>
    </main>
  );
}
