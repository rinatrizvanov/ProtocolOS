"use client";

import { useState } from "react";
import { investigate, type Investigation, type Statement } from "@/lib/api";
import { Failed, Frame } from "../components/Frame";

type Run = { status: "idle" } | { status: "busy" } | { status: "error"; message: string } | { status: "ready"; data: Investigation };

function isVerified(statement: Statement): boolean {
  return statement.status === "supported" && statement.failed_checks.length === 0;
}

function StatusMark({ verified }: { verified: boolean }) {
  return verified ? (
    <svg aria-label="checked" viewBox="0 0 20 20" className="mt-1 h-5 w-5 shrink-0 text-support" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M4 10.5l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <span aria-label="uncertain" className="mt-3 h-0.5 w-4 shrink-0 bg-uncounted" />
  );
}

function Meter({ testId, label, value }: { testId: string; label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span data-testid={testId} className="text-2xl font-semibold tabular-nums text-ink">{value}</span>
      <span className="text-sm text-muted">{label}</span>
    </div>
  );
}

function Result({ data }: { data: Investigation }) {
  const statements = data.answer.statements;
  const against = statements.filter((s) => s.polarity === "challenges").length;
  const forRule = statements.filter((s) => s.polarity === "supports").length + data.counterevidence.length;
  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      <ul className="flex flex-col gap-3">
        {statements.map((s) => (
          <li key={s.id} data-testid="statement" data-status={s.status} className="flex gap-3">
            <StatusMark verified={isVerified(s)} />
            <span className="line-clamp-2 text-lg text-ink">{s.text}</span>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 border-y border-line">
        <div className="flex items-baseline gap-3 bg-look-soft px-4 py-3">
          <span className="text-3xl font-semibold tabular-nums text-ink">{against}</span>
          <span className="text-muted">Against the rule</span>
        </div>
        <div className="flex items-baseline gap-3 bg-support-soft px-4 py-3">
          <span className="text-3xl font-semibold tabular-nums text-ink">{forRule}</span>
          <span className="text-muted">For the rule</span>
        </div>
      </div>
      <div className="flex gap-10">
        <Meter testId="meter-tools" label="tool calls" value={`${data.budget.used}/${data.budget.max_tool_calls}`} />
        <Meter testId="meter-model" label="model calls" value={`${data.budget.used_model}/${data.budget.max_model_calls}`} />
        <Meter testId="meter-seconds" label="seconds" value={data.elapsed_s.toFixed(1)} />
      </div>
    </div>
  );
}

export default function Screen4() {
  const [run, setRun] = useState<Run>({ status: "idle" });

  function ask() {
    setRun({ status: "busy" });
    investigate().then(
      (data) => setRun({ status: "ready", data }),
      (err: unknown) => setRun({ status: "error", message: err instanceof Error ? err.message : String(err) }),
    );
  }

  const details =
    run.status === "ready" ? (
      <>
        <ul className="list-disc space-y-1 pl-5">
          {run.data.answer.statements.map((s) => (
            <li key={s.id}>{s.text} ({s.status}, {s.polarity})</li>
          ))}
        </ul>
        <p>
          Checks passed: {run.data.checks.filter((c) => c.result === "pass").length}/{run.data.checks.length}. Mode: {run.data.mode}. Model:{" "}
          {run.data.model.status}.
        </p>
      </>
    ) : undefined;

  return (
    <Frame
      headline="Ask why. Every sentence is checked."
      caption="Each sentence in the answer is checked against its cited sources, and the agent works within a fixed budget of tool and model calls."
      details={details}
    >
      {run.status === "ready" ? (
        <Result data={run.data} />
      ) : (
        <div className="flex flex-col items-start gap-4">
          <button
            type="button"
            data-testid="run-investigation"
            onClick={ask}
            disabled={run.status === "busy"}
            className="rounded-md border border-ink bg-ink px-6 py-3 text-lg text-paper transition-opacity duration-150 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            {run.status === "busy" ? "Checking the sources…" : "Ask why it was flagged"}
          </button>
          {run.status === "error" ? <Failed message={run.message} /> : null}
        </div>
      )}
    </Frame>
  );
}
