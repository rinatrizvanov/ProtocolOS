"use client";

import { Fragment, useRef, useState, type FormEvent } from "react";
import { QUESTIONS, investigate, type Investigation, type Question, type Selection, type Statement } from "@/lib/api";
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

type Turn = { id: number; text: string; key: Question | null; routed: boolean; run: Run };

// Typed text never reaches the API: the investigator accepts only its four fixed questions, so text is matched to one.
const KEYWORDS: [RegExp, Question][] = [
  [/contradict|against|challenge|oppos/i, "contradicting"],
  [/support|keep|retain|justif/i, "support_retaining"],
  [/change|what if|would|revis/i, "what_would_change"],
  [/why|flag|reason/i, "why_flagged"],
];

function matchQuestion(text: string): { key: Question | null; exact: boolean } {
  const t = text.trim().toLowerCase();
  const exact = (Object.keys(QUESTIONS) as Question[]).find((q) => QUESTIONS[q].toLowerCase() === t);
  if (exact) return { key: exact, exact: true };
  return { key: KEYWORDS.find(([pattern]) => pattern.test(t))?.[1] ?? null, exact: false };
}

function Suggestions({ prefix, onPick }: { prefix: string; onPick: (q: Question) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {(Object.keys(QUESTIONS) as Question[]).map((q) => (
        <button
          key={q}
          type="button"
          data-testid={`${prefix}-${q}`}
          onClick={() => onPick(q)}
          className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors duration-150 hover:border-ink hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
        >
          {QUESTIONS[q]}
        </button>
      ))}
    </div>
  );
}

export default function Screen4({ nct, criterionId }: Selection) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const busy = turns.some((t) => t.run.status === "busy");
  const latest = turns.findLast((t) => t.run.status === "ready")?.run;

  function suggest(q: Question) {
    setDraft(QUESTIONS[q]);
    input.current?.focus();
  }

  function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    const { key, exact } = matchQuestion(text);
    const id = turns.length;
    setTurns((prev) => [...prev, { id, text, key, routed: key !== null && !exact, run: key ? { status: "busy" } : { status: "idle" } }]);
    setDraft("");
    if (!key) return;
    const settle = (run: Run) => setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, run } : t)));
    investigate(nct, criterionId, key).then(
      (data) => settle({ status: "ready", data }),
      (err: unknown) => {
        console.error(err);
        settle({ status: "error", message: err instanceof Error ? err.message : String(err) });
      },
    );
  }

  const details =
    latest?.status === "ready" ? (
      <>
        <ul className="list-disc space-y-1 pl-5">
          {latest.data.answer.statements.map((s) => (
            <li key={s.id}>{s.text} ({s.status}, {s.polarity})</li>
          ))}
        </ul>
        <p>
          Checks passed: {latest.data.checks.filter((c) => c.result === "pass").length}/{latest.data.checks.length}. Mode: {latest.data.mode}. Model:{" "}
          {latest.data.model.status}.
        </p>
      </>
    ) : undefined;

  return (
    <Frame
      headline="Ask why. Every sentence is checked."
      caption="Ask in your own words or pick a question. Answers come from the evidence graph, and every sentence is checked before it appears."
      details={details}
    >
      <div className="flex w-full max-w-4xl flex-col gap-4">
        <div role="log" aria-live="polite" aria-label="Conversation" className="flex max-h-[50vh] flex-col gap-4 overflow-y-auto">
          {turns.map((t) => (
            <Fragment key={t.id}>
              <p data-testid="chat-message" data-role="user" className="max-w-[80%] self-end rounded-md bg-line px-4 py-2 text-ink">
                {t.text}
              </p>
              <div data-testid="chat-message" data-role="assistant" className="flex flex-col gap-2">
                {t.key === null ? (
                  <>
                    <p className="text-ink">I answer from this rule&apos;s evidence graph, so I can take these questions:</p>
                    <Suggestions prefix="retry" onPick={suggest} />
                  </>
                ) : null}
                {t.routed && t.key ? <p className="text-sm text-muted">Answering: {QUESTIONS[t.key]}</p> : null}
                {t.run.status === "busy" ? <p className="text-muted">Checking the sources…</p> : null}
                {t.run.status === "error" ? <Failed message={t.run.message} /> : null}
                {t.run.status === "ready" ? <Result data={t.run.data} /> : null}
              </div>
            </Fragment>
          ))}
        </div>
        <form onSubmit={send} className="flex gap-2">
          <input
            ref={input}
            data-testid="chat-input"
            aria-label="Ask about this rule"
            placeholder="Ask about this rule…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="flex-1 rounded-md border border-line bg-paper px-4 py-3 text-lg text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
          />
          <button
            type="submit"
            data-testid="run-investigation"
            disabled={!draft.trim() || busy}
            className="rounded-md bg-ink px-6 py-3 text-lg text-paper transition-opacity duration-150 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Send
          </button>
        </form>
        <Suggestions prefix="question" onPick={suggest} />
      </div>
    </Frame>
  );
}
