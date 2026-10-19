"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  EngineError,
  QUESTIONS,
  getReview,
  investigate,
  questionLabel,
  sameAsSupport,
  type AskMode,
  type Classification,
  type Investigation,
  type Question,
  type Selection,
  type Statement,
} from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { useModelKey } from "@/lib/visitor";
import { Failed, Frame } from "../components/Frame";
import { ModelKeyForm } from "../components/ModelKeyForm";

type Run = { status: "idle" } | { status: "busy" } | { status: "error"; message: string } | { status: "ready"; data: Investigation };
type Mark = "checked" | "context" | "failed";

function markOf(statement: Statement): Mark {
  if (statement.status === "unsupported" || statement.failed_checks.length > 0) return "failed";
  return statement.status === "supported" ? "checked" : "context";
}

const MARK_LABEL: Record<Mark, string> = {
  checked: "Tied to a checked source",
  context: "Context or classification, no single source to cite",
  failed: "Failed a check",
};

function StatusMark({ mark }: { mark: Mark }) {
  if (mark === "checked")
    return (
      <svg role="img" aria-label={MARK_LABEL.checked} viewBox="0 0 20 20" className="mt-0.5 h-5 w-5 shrink-0 text-support" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="M4 10.5l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  if (mark === "failed")
    return (
      <svg role="img" aria-label={MARK_LABEL.failed} viewBox="0 0 20 20" className="mt-0.5 h-5 w-5 shrink-0 text-verdict" fill="none" stroke="currentColor" strokeWidth="2.5">
        <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" strokeLinecap="round" />
      </svg>
    );
  return (
    <span role="img" aria-label={MARK_LABEL.context} className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center">
      <span className="h-0.5 w-3.5 rounded bg-uncounted" />
    </span>
  );
}

// Engine enums in the Details list, in words.
const STATUS_TEXT: Record<string, string> = { supported: "tied to a source", uncertain: "context, no source claim", unsupported: "failed a check" };
const POLARITY_TEXT: Record<string, string> = { challenges: "against the rule", supports: "for the rule", context: "context", neutral: "context" };

function modelText(model: Investigation["model"]): string {
  if (model.status === "not_used") return "no model used";
  if (model.status === "not configured") return "model not configured";
  if (model.status === "ok") return `model answered${model.provider ? ` (${model.provider})` : ""}, every sentence checked`;
  return `model ${model.status}`;
}

function Result({ data }: { data: Investigation }) {
  const statements = data.answer.statements;
  const marks = statements.map(markOf);
  return (
    <div className="flex w-full max-w-3xl flex-col gap-2">
      {data.mode === "model" ? (
        <p data-testid="answered-by" className="text-xs text-muted">
          Written by {data.model.provider ?? "the model"} from this criterion&apos;s rationale graph; every sentence checked, and one that fails
          is marked with a cross. The classification never changes.
        </p>
      ) : data.model.status.startsWith("unavailable") ? (
        <p data-testid="model-unavailable" className="text-xs text-look-ink">
          The model did not answer ({data.model.status.replace(/^unavailable: /, "")}); the rule-based answer is shown.
        </p>
      ) : null}
      <figure className="flex flex-col gap-1.5">
        <figcaption className="text-xs font-medium text-muted">Investigator answer, verbatim; every sentence checked against the sources</figcaption>
        <ul data-role="quote" className="flex flex-col gap-2">
          {statements.map((s, i) => (
            <li key={s.id} data-testid="statement" data-status={s.status} className="flex gap-2.5">
              <StatusMark mark={marks[i]} />
              <span className="text-base leading-snug text-ink">{s.text}</span>
            </li>
          ))}
        </ul>
      </figure>
      <p className="text-xs text-muted">
        Tick: tied to a checked source. Dash: context or classification, no single source to cite.
        {marks.includes("failed") ? " Cross: failed a check." : ""}
      </p>
      <p className="text-xs tabular-nums text-muted">
        <span data-testid="meter-tools">
          {data.budget.used} of {data.budget.max_tool_calls}
        </span>{" "}
        tool calls ·{" "}
        <span data-testid="meter-model">
          {data.budget.used_model} of {data.budget.max_model_calls}
        </span>{" "}
        model calls · <span data-testid="meter-seconds">{data.elapsed_s.toFixed(1)}</span> s
      </p>
    </div>
  );
}

type Turn = { id: number; text: string; key: Question | null; routed: boolean; run: Run };

const MODES: { id: AskMode; label: string; hint: string }[] = [
  { id: "deterministic", label: "Rules only", hint: "Template answers from the rationale graph. No model, no key." },
  { id: "model", label: "A model, with your key", hint: "The model you choose writes the answer from the same rationale graph; the same checks apply." },
];

function ModePicker({ mode, onChange, disabled }: { mode: AskMode; onChange: (m: AskMode) => void; disabled: boolean }) {
  return (
    <fieldset className="flex flex-col gap-1.5" disabled={disabled}>
      <legend className="text-sm text-muted">Answer with</legend>
      <div className="flex flex-wrap gap-2">
        {MODES.map((m) => (
          <label
            key={m.id}
            title={m.hint}
            className={`flex min-h-11 cursor-pointer items-center rounded-md border px-3 py-1.5 text-sm sm:min-h-9 ${
              mode === m.id ? "border-ink bg-line text-ink" : "border-uncounted text-muted hover:text-ink"
            } has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ink`}
          >
            <input type="radio" name="ask-mode" data-testid={`ask-mode-${m.id}`} value={m.id} checked={mode === m.id} onChange={() => onChange(m.id)} className="sr-only" />
            {m.label}
          </label>
        ))}
      </div>
      <p className="text-xs text-muted">{MODES.find((m) => m.id === mode)?.hint}</p>
    </fieldset>
  );
}

// Typed text never reaches the API: the investigator accepts only its four fixed questions, so text is matched to one.
const KEYWORDS: [RegExp, Question][] = [
  [/contradict|against|challenge|oppos/i, "contradicting"],
  [/support|keep|retain|justif/i, "support_retaining"],
  [/change|what if|would|revis/i, "what_would_change"],
  [/why|flag|reason|classif/i, "why_flagged"],
];

function matchQuestion(text: string, classification: Classification | null): { key: Question | null; exact: boolean } {
  const t = text.trim().toLowerCase();
  const exact = (Object.keys(QUESTIONS) as Question[]).find(
    (q) => QUESTIONS[q].toLowerCase() === t || questionLabel(q, classification).toLowerCase() === t,
  );
  if (exact) return { key: exact, exact: true };
  return { key: KEYWORDS.find(([pattern]) => pattern.test(t))?.[1] ?? null, exact: false };
}

function Suggestions({ classification, disabled, onPick }: { classification: Classification | null; disabled: boolean; onPick: (q: Question) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Questions the investigator answers">
      {(Object.keys(QUESTIONS) as Question[]).map((q) => (
        <button
          key={q}
          type="button"
          data-testid={`question-${q}`}
          disabled={disabled}
          onClick={() => onPick(q)}
          className="min-h-11 rounded-md border border-uncounted bg-paper px-3 py-1.5 text-sm text-ink transition-colors duration-150 hover:border-ink disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink sm:min-h-9"
        >
          {questionLabel(q, classification)}
        </button>
      ))}
    </div>
  );
}

// `autoAsk` runs one question on mount (the tour shows an answer, not an empty form); `variant="app"` is the review tab.
export default function Screen4({
  nct,
  criterionId,
  autoAsk,
  variant = "tour",
}: Selection & { autoAsk?: Question; variant?: "tour" | "app" }) {
  const review = useApi(() => getReview(nct));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<AskMode>("deterministic");
  const modelKey = useModelKey();
  // The tour shows rule-based answers only; the app tab may use the visitor's model.
  const useModel = variant === "app" && mode === "model";
  const needsKey = useModel && modelKey === null;
  const asked = useRef(false);
  const next = useRef(0);

  const row = review.status === "ready" ? review.data.reviews.find((r) => r.criterion.id === criterionId) : undefined;
  const classification = row?.classification ?? null;
  const busy = turns.some((t) => t.run.status === "busy");
  const latest = turns.find((t) => t.run.status === "ready")?.run;

  function ask(text: string, key: Question | null, routed: boolean) {
    const id = next.current++;
    // Newest first: the answer to the question just asked is at the top, under the input.
    setTurns((prev) => [{ id, text, key, routed, run: key ? { status: "busy" } : { status: "idle" } }, ...prev]);
    if (!key) return;
    const settle = (run: Run) => setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, run } : t)));
    investigate(nct, criterionId, key, useModel ? "model" : "deterministic").then(
      (data) => settle({ status: "ready", data }),
      (err: unknown) => {
        console.error(err);
        settle({ status: "error", message: err instanceof EngineError ? (err.detail ?? err.message) : err instanceof Error ? err.message : String(err) });
      },
    );
  }

  useEffect(() => {
    if (!autoAsk || asked.current) return;
    asked.current = true;
    ask(QUESTIONS[autoAsk], autoAsk, false);
    // One automatic question per mount; the panel is keyed by trial and criterion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk]);

  function pick(q: Question) {
    if (busy || needsKey) return;
    ask(questionLabel(q, classification), q, false);
  }

  function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy || needsKey) return;
    const { key, exact } = matchQuestion(text, classification);
    setDraft("");
    ask(text, key, key !== null && !exact);
  }

  const details =
    latest?.status === "ready" ? (
      <>
        <figure>
          <figcaption className="text-xs font-medium text-muted">Latest answer, verbatim, with each sentence&apos;s check</figcaption>
          <ul data-role="quote" className="mt-1 list-disc space-y-1 pl-5">
            {latest.data.answer.statements.map((s) => (
              <li key={s.id}>
                {s.text} ({STATUS_TEXT[s.status] ?? s.status}; {POLARITY_TEXT[s.polarity] ?? s.polarity})
              </li>
            ))}
          </ul>
        </figure>
        <p>
          Checks passed: {latest.data.checks.filter((c) => c.result === "pass").length} of {latest.data.checks.length}.{" "}
          {latest.data.mode === "deterministic" ? "Deterministic mode" : `Mode: ${latest.data.mode}`}; {modelText(latest.data.model)}.
        </p>
      </>
    ) : undefined;

  const app = variant === "app";
  return (
    <Frame
      variant={variant}
      headline={app ? "Ask about this criterion" : "Ask why. Every sentence is checked."}
      caption="Pick a question or type one. Answers come from this criterion's rationale graph, and every sentence is checked before it appears."
      details={details}
    >
      <div className="flex w-full max-w-4xl flex-col gap-4">
        {row ? (
          <p data-testid="ask-score" className="text-sm text-ink">
            Score: <span className="font-semibold tabular-nums">+{row.scores.challenge} against</span> /{" "}
            <span className="font-semibold tabular-nums">+{row.scores.support} for</span>{" "}
            <span className="text-muted">(points, as on the Rationale tab)</span>
          </p>
        ) : null}
        {app ? <ModePicker mode={mode} onChange={setMode} disabled={busy} /> : null}
        {needsKey ? (
          <ModelKeyForm purpose="Model answers are billed to your key. The model sees only this criterion's rationale graph, every sentence it writes is checked against the sources, and it cannot change the classification." />
        ) : null}
        <Suggestions classification={classification} disabled={busy || needsKey} onPick={pick} />
        <form onSubmit={send} className="flex gap-2">
          <input
            data-testid="chat-input"
            aria-label="Ask about this rule"
            placeholder="Or type a question…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-uncounted bg-paper px-3 py-2 text-base text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
          />
          <button
            type="submit"
            data-testid="run-investigation"
            disabled={!draft.trim() || busy || needsKey}
            className="rounded-md bg-ink px-5 py-2 text-base text-paper transition-opacity duration-150 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Send
          </button>
        </form>
        <div aria-live="polite" aria-label="Answers, newest first" className="flex flex-col gap-6">
          {turns.map((t) => (
            <div key={t.id} data-testid="chat-turn" className="flex flex-col gap-3 border-t border-line pt-4">
              <p data-testid="chat-message" data-role="user" className="max-w-[80%] self-end rounded-md bg-line px-3 py-1.5 text-ink">
                {t.text}
              </p>
              <div data-testid="chat-message" data-role="assistant" className="flex flex-col gap-2">
                {t.key === null ? (
                  <p className="text-ink">I answer from this rule&apos;s rationale graph, so I can take only the four questions above.</p>
                ) : null}
                {t.routed && t.key ? <p className="text-sm text-muted">Answering: {questionLabel(t.key, classification)}</p> : null}
                {t.key && sameAsSupport(t.key, classification) ? (
                  <p className="text-sm text-muted">Same sources as &ldquo;{QUESTIONS.support_retaining}&rdquo;: for this classification, both start from what argues for the rule.</p>
                ) : null}
                {t.run.status === "busy" ? <p className="text-muted">Checking the sources…</p> : null}
                {t.run.status === "error" ? <Failed message={t.run.message} action="get an answer" /> : null}
                {t.run.status === "ready" ? <Result data={t.run.data} /> : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Frame>
  );
}
