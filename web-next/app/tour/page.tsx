"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CRITERION, NCT } from "@/lib/api";
import Screen1 from "../screens/Screen1";
import Screen2 from "../screens/Screen2";
import Screen3 from "../screens/Screen3";
import Screen4 from "../screens/Screen4";
import Screen5 from "../screens/Screen5";
import Screen6 from "../screens/Screen6";
import Screen7 from "../screens/Screen7";

const STEPS = [
  { title: "The rules", render: () => <Screen1 nct={NCT} /> },
  { title: "Compared", render: () => <Screen2 nct={NCT} criterionId={CRITERION} /> },
  { title: "Why flagged", render: () => <Screen3 nct={NCT} criterionId={CRITERION} /> },
  { title: "Ask why", render: () => <Screen4 nct={NCT} criterionId={CRITERION} /> },
  { title: "Caught", render: () => <Screen5 nct={NCT} /> },
  { title: "Tested", render: () => <Screen6 /> },
  { title: "Decide", render: () => <Screen7 nct={NCT} criterionId={CRITERION} /> },
];

// The step lives in the URL hash (#1..#7) so a screen can be opened directly.
function stepFromHash(): number {
  const n = Number(window.location.hash.slice(1));
  return Number.isInteger(n) && n >= 1 && n <= STEPS.length ? n - 1 : 0;
}

export default function Tour() {
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
        <Link
          href={`/?nct=${NCT}&c=${CRITERION}`}
          data-testid="exit-demo"
          className="rounded-md px-3 py-1 text-sm text-ink hover:bg-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
        >
          Exit demo
        </Link>
      </nav>

      <div className="mt-10 flex flex-1 flex-col">
        <div key={step} className="flex flex-1 flex-col">
          {STEPS[step].render()}
        </div>
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
