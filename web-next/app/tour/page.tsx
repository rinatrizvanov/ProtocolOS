"use client";

import { useCallback, useEffect, useState } from "react";
import { CRITERION, NCT } from "@/lib/api";
import { AppHeader } from "../components/AppHeader";
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
  { title: "Rationale", render: () => <Screen3 nct={NCT} criterionId={CRITERION} /> },
  { title: "Ask", render: () => <Screen4 nct={NCT} criterionId={CRITERION} autoAsk="why_flagged" /> },
  { title: "Verify", render: () => <Screen5 nct={NCT} /> },
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
    if (step !== null) document.title = `Guided tour, step ${step + 1} of ${STEPS.length} · ProtocolOS`;
  }, [step]);

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
    <>
      <AppHeader mode="tour" />
      <main className="mx-auto flex max-w-6xl flex-col px-4 py-4 sm:px-6">
        <nav aria-label="Demo steps" className="flex items-center gap-x-3 sm:flex-wrap sm:gap-x-6 sm:gap-y-2">
          {/* Phones: one row with the step name, a progress row of dots and Exit; Back and Next sit in the footer. */}
          <p className="min-w-0 flex-1 truncate text-sm text-ink sm:hidden" aria-live="polite">
            Step <span className="tabular-nums">{step + 1}</span> of <span className="tabular-nums">{STEPS.length}</span> · {STEPS[step].title}
          </p>
          <span aria-hidden className="flex shrink-0 items-center gap-1 sm:hidden">
            {STEPS.map((s, i) => (
              <span key={s.title} className={`h-2 w-2 rounded-full ${i === step ? "bg-ink" : i < step ? "bg-muted" : "bg-line"}`} />
            ))}
          </span>
          <ol className="hidden flex-1 flex-wrap items-center gap-2 sm:flex">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <button
                  type="button"
                  onClick={() => go(i)}
                  aria-current={i === step ? "step" : undefined}
                  className={`flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink ${
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
          <span className="hidden text-sm tabular-nums text-muted sm:inline">
            {step + 1} / {STEPS.length}
          </span>
          <a
            href={`../review?nct=${NCT}&c=${CRITERION}`}
            data-testid="exit-demo"
            className="flex min-h-11 shrink-0 items-center rounded-md px-3 text-sm text-ink hover:bg-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink sm:min-h-0 sm:py-1"
          >
            Exit<span className="hidden sm:inline">&nbsp;to the review</span>
          </a>
        </nav>

        <div className="mt-4 flex flex-1 flex-col">
          <div key={step} className="flex flex-1 flex-col">
            {STEPS[step].render()}
          </div>
        </div>

        <footer className="mt-4 flex items-center justify-between border-t border-line pt-3">
          <button
            type="button"
            onClick={() => go(step - 1)}
            disabled={step === 0}
            className="rounded-md px-4 py-2 text-ink transition-colors duration-150 hover:bg-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:invisible"
          >
            Back
          </button>
          <span className="text-sm text-muted pointer-coarse:hidden">Arrow keys move between steps</span>
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
    </>
  );
}
