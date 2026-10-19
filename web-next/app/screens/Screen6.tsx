"use client";

import { useEffect, useState } from "react";
import { CRITERION, NCT, getEvals, getPlanted, probeStatus, type Evals, type Planted } from "../../lib/api";
import { useApi } from "../../lib/useApi";
import { Failed, Frame, Pending } from "../components/Frame";

// Each probe names the refusal the public-demo guard gives (trialforge/demo_guard.py, access.py). Only that status earns the lock;
// anything else means the guard is not active on this server, and the screen says so instead of claiming it is locked.
interface Probe {
  meaning: string;
  open: string;
  expected: number;
  run: () => Promise<number>;
}

const PROBES: Probe[] = [
  { meaning: "Refresh not allowed", open: "Refresh allowed", expected: 403, run: () => probeStatus(`/api/review/${NCT}?refresh=1`) },
  { meaning: "Path tricks refused", open: "Path tricks not refused", expected: 400, run: () => probeStatus(`/api/review/${NCT}?as_of=../../x`) },
  {
    meaning: "Model calls need your own key",
    open: "Model calls run without a key",
    expected: 401,
    run: () =>
      probeStatus("/api/critique", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nct: NCT, criterion_id: CRITERION }),
      }),
  },
];

const loadScores = () => Promise.all([getPlanted(), getEvals()]);

function Stat({ testId, value, of, label }: { testId: string; value: number; of: number; label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <p data-testid={testId} className="text-6xl font-semibold tabular-nums text-ink">
        {value} <span className="text-3xl font-normal text-muted">of {of}</span>
      </p>
      <p className="text-base text-muted">{label}</p>
    </div>
  );
}

function LockGlyph({ locked }: { locked: boolean }) {
  return locked ? (
    <svg aria-hidden="true" viewBox="0 0 16 20" className="h-6 w-5 shrink-0 text-ink" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 9V6a4 4 0 0 1 8 0v3" />
      <rect x="2" y="9" width="12" height="9" rx="1" />
    </svg>
  ) : (
    <svg aria-hidden="true" viewBox="0 0 16 20" className="h-6 w-5 shrink-0 text-look-ink" fill="none" stroke="currentColor" strokeWidth="1.6">
      <path d="M4 9V6a4 4 0 0 1 7.6-1.8" />
      <rect x="2" y="9" width="12" height="9" rx="1" />
    </svg>
  );
}

// null: still waiting; true: every probe got its refusal; false: at least one was allowed or got no answer.
function guardActive(statuses: (number | string | null)[]): boolean | null {
  if (statuses.some((s) => s === null)) return null;
  return PROBES.every((probe, i) => statuses[i] === probe.expected);
}

// One run per page load: React dev mode mounts effects twice and would send each refused request twice.
let probeRuns: Promise<number>[] | null = null;

function useProbeStatuses(): (number | string | null)[] {
  const [statuses, setStatuses] = useState<(number | string | null)[]>(PROBES.map(() => null));
  useEffect(() => {
    let live = true;
    probeRuns ??= PROBES.map((probe) => probe.run());
    probeRuns.forEach((run, index) => {
      run.then(
        (status) => live && setStatuses((prev) => prev.map((s, i) => (i === index ? status : s))),
        (err: unknown) => {
          console.error(err);
          if (live) setStatuses((prev) => prev.map((s, i) => (i === index ? "no response" : s)));
        },
      );
    });
    return () => {
      live = false;
    };
  }, []);
  return statuses;
}

function Body({ planted, evals, statuses }: { planted: Planted; evals: Evals; statuses: (number | string | null)[] }) {
  const [escalated, stricterOf] = planted.summary.stricter.escalated_strict;
  const [wrongFlags, looserOf] = planted.summary.looser.false_over_restriction_flags;
  const extraction = evals.suites.extraction;
  return (
    <div className="flex w-full flex-col gap-14">
      <div className="grid grid-cols-1 gap-10 sm:grid-cols-3">
        <Stat testId="stat-planted" value={escalated} of={stricterOf} label="planted stricter rules escalated" />
        <Stat testId="stat-looser" value={wrongFlags} of={looserOf} label="looser variants wrongly flagged" />
        <Stat testId="stat-extraction" value={extraction.found_correct} of={extraction.gold_criteria} label="rules extracted correctly" />
      </div>
      <ul className="grid grid-cols-1 gap-6 border-t border-line pt-8 sm:grid-cols-3">
        {PROBES.map((probe, index) => {
          const status = statuses[index];
          const locked = status === probe.expected;
          return (
            <li key={probe.meaning} data-testid="blocked" data-status={status ?? ""} data-locked={status === null ? "" : String(locked)} className="flex items-center gap-4">
              {status === null ? <span className="h-6 w-5 shrink-0" /> : <LockGlyph locked={locked} />}
              <span className={`text-4xl font-semibold tabular-nums ${locked || status === null ? "text-ink" : "text-look-ink"}`}>{status ?? "–"}</span>
              <span className="text-base text-muted">
                {status === null || locked ? probe.meaning : `${probe.open}: the public-demo guard is not active on this server (got ${status})`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default function Screen6() {
  const scores = useApi(loadScores);
  const statuses = useProbeStatuses();
  const details =
    scores.status === "ready" ? (
      <>
        {/* lib/api.ts types label as string, but the live /api/planted response has no label field today. */}
        <p>{scores.data[0].label || "Planted variants are synthetic rule edits, not clinical validation."}</p>
        <p>
          Field accuracy {(scores.data[1].suites.extraction.field_accuracy * 100).toFixed(1)}% across{" "}
          {scores.data[1].suites.extraction.protocols} protocols.
        </p>
      </>
    ) : undefined;
  const guard = guardActive(statuses);
  return (
    <Frame
      headline={guard === false ? "Tested." : "Tested and locked down."}
      caption={
        guard === false ? (
          <>
            Scored against planted rule changes and gold labels.{" "}
            <span data-testid="guard-off" className="text-look-ink">
              The public-demo guard is off on this server: not every risky request below was refused.
            </span>
          </>
        ) : (
          "Scored against planted rule changes and gold labels; the public demo refuses risky requests, live, as you watch."
        )
      }
      details={details}
    >
      {scores.status === "loading" ? <Pending label="Loading eval results" /> : null}
      {scores.status === "error" ? <Failed message={scores.message} /> : null}
      {scores.status === "ready" ? <Body planted={scores.data[0]} evals={scores.data[1]} statuses={statuses} /> : null}
    </Frame>
  );
}
