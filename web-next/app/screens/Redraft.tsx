"use client";

// Redraft workspace: the criterion as written in the protocol, an editable redraft and a live column of checks
// (protocol text, similar trials, FDA guidance, NHANES, the verifier) that refreshes 450 ms after typing stops.
// The guided tour passes `prefill` (a redraft typed for the viewer once the protocol text loads) and `exampleNote`
// (a button that fills the rationale note with a labelled example), so the live checks show without typing.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { getReview, type Selection } from "@/lib/api";
import { redraft, type FlagLevel, type RedraftFlag, type RedraftResult } from "@/lib/redraft";

const DEBOUNCE_MS = 450;

const LEVELS: { level: FlagLevel; title: string; tone: string; dot: string }[] = [
  { level: "fail", title: "Fails", tone: "border-verdict/40 bg-verdict/5", dot: "text-verdict" },
  { level: "warn", title: "Needs review", tone: "border-look/40 bg-look-soft/60", dot: "text-look-ink" },
  { level: "info", title: "For context", tone: "border-line bg-uncounted-soft/60", dot: "text-muted" },
  { level: "pass", title: "Holds", tone: "border-support/30 bg-support-soft/60", dot: "text-support" },
];

const STATUS_TEXT: Record<string, { label: string; tone: string }> = {
  PASSED: { label: "Verifier: passed", tone: "border-support/40 bg-support-soft text-support" },
  PASSED_WITH_WARNINGS: { label: "Verifier: passed with warnings", tone: "border-look/40 bg-look-soft text-look-ink" },
  REJECTED: { label: "Verifier: rejected", tone: "border-verdict/40 bg-verdict/5 text-verdict" },
};

function Glyph({ level, className = "" }: { level: FlagLevel; className?: string }) {
  const common = { viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, className: `size-4 shrink-0 ${className}` };
  if (level === "fail")
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="7.5" />
        <path d="m7.2 7.2 5.6 5.6M12.8 7.2l-5.6 5.6" />
      </svg>
    );
  if (level === "warn")
    return (
      <svg {...common}>
        <path d="M10 3.2 17.4 16H2.6L10 3.2Z" />
        <path d="M10 8.2v3.6M10 13.9v.1" />
      </svg>
    );
  if (level === "pass")
    return (
      <svg {...common}>
        <circle cx="10" cy="10" r="7.5" />
        <path d="m6.8 10.2 2.2 2.2 4.3-4.6" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 9v4.5M10 6.4v.1" />
    </svg>
  );
}

function SourceLink({ flag }: { flag: RedraftFlag }) {
  const s = flag.source;
  if (!s) return null;
  const text = `${s.label}${s.page ? `, p. ${s.page}` : ""}`;
  return s.url ? (
    <a href={s.url} target="_blank" rel="noreferrer" className="text-xs text-muted underline decoration-line underline-offset-2 hover:text-ink">
      {text}
    </a>
  ) : (
    <span className="text-xs text-muted">{text}</span>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-md border border-line bg-white/70 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

// Display-time relabel: engine and verifier sentences say "evidence"; the UI keeps that word for "Insufficient evidence".
const relabel = (t: string) => t.replace(/(?<!Insufficient )\bevidence\b/gi, "sources");

// The NHANES caveat's Duffy-null sentence is about neutrophil counts; other analytes show only the general sentence.
function caveatFor(caveat: string, criterionId: string): string {
  const sentences = caveat.match(/[^.]+(?:\.|$)/g)?.map((x) => x.trim()).filter(Boolean) ?? [caveat];
  return sentences.filter((x) => criterionId === "anc" || !/duffy/i.test(x)).join(" ");
}

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? "" : Number.isInteger(n) ? n.toFixed(1) : String(n));

export default function Redraft({ nct, criterionId, prefill, exampleNote }: Selection & { prefill?: string; exampleNote?: string }) {
  const [text, setText] = useState("");
  const [rationale, setRationale] = useState("");
  const [result, setResult] = useState<RedraftResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef<AbortController | null>(null);
  const touched = useRef(false);
  const original = useRef<string>("");

  function run(nextText: string, nextRationale: string) {
    inflight.current?.abort();
    const ctrl = new AbortController();
    inflight.current = ctrl;
    setChecking(true);
    redraft({ nct, criterion_id: criterionId, text: nextText, rationale: nextRationale }, ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        setResult(data);
        setError(null);
        setChecking(false);
        // First answer: prefill the redraft with the verbatim protocol text (or the tour's example) and check that.
        if (!touched.current && !original.current && data.original?.text) {
          original.current = data.original.text;
          const first = prefill ?? data.original.text;
          if (prefill) touched.current = true;
          setText(first);
          if (first !== nextText) run(first, nextRationale);
        }
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setChecking(false);
      });
  }

  function schedule(nextText: string, nextRationale: string) {
    if (timer.current) clearTimeout(timer.current);
    if (!nextText.trim()) {
      inflight.current?.abort();
      setChecking(false);
      setError("Type the criterion to check it.");
      return;
    }
    timer.current = setTimeout(() => run(nextText, nextRationale), DEBOUNCE_MS);
  }

  // Start from the reviewed criterion; the first answer replaces it with the verbatim protocol sentence.
  useEffect(() => {
    let cancelled = false;
    getReview(nct)
      .then((review) => {
        if (cancelled) return;
        const c = review.reviews.find((r) => r.criterion.id === criterionId)?.criterion;
        const seed = c ? [c.label, c.operator, fmt(c.value_norm), c.unit_norm].filter(Boolean).join(" ") : criterionId;
        run(seed, "");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setChecking(false);
      });
    return () => {
      cancelled = true;
      inflight.current?.abort();
      if (timer.current) clearTimeout(timer.current);
    };
    // run is stable for one mount: the tab panel is keyed by trial and criterion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nct, criterionId]);

  const onText = (v: string) => {
    touched.current = true;
    setText(v);
    schedule(v, rationale);
  };
  const onRationale = (v: string) => {
    setRationale(v);
    schedule(text, v);
  };
  const reset = () => {
    touched.current = false;
    setText(original.current);
    setRationale("");
    schedule(original.current, "");
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(rationale.trim() ? `${text}\n\nRationale: ${rationale}` : text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const o = result?.original;
  const status = result?.verification ? STATUS_TEXT[result.verification.status] : undefined;
  const pop = result?.population;
  const limit = result?.parsed ?? o;
  const dirty = touched.current && text !== original.current;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-4 lg:self-start">
        <Section
          title="As written in the protocol"
          aside={
            o?.page ? (
              o.url ? (
                <a href={`${o.url}#page=${o.page}`} target="_blank" rel="noreferrer" className="text-xs text-muted underline underline-offset-2 hover:text-ink">
                  Protocol p. {o.page}
                </a>
              ) : (
                <span className="text-xs text-muted">Protocol p. {o.page}</span>
              )
            ) : null
          }
        >
          {o ? (
            <blockquote data-role="quote" className="border-l-2 border-line pl-3 text-sm leading-relaxed text-ink">
              {o.text}
            </blockquote>
          ) : (
            <p className="text-sm text-muted">{error ? "Not available." : "Loading the protocol text..."}</p>
          )}
        </Section>

        <section className="rounded-md border border-ink/20 bg-white p-3 shadow-sm">
          <div className="mb-2 flex items-center justify-between gap-2">
            <label htmlFor="redraft-input" className="text-xs font-semibold uppercase tracking-wide text-ink">
              Your redraft
            </label>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={reset}
                disabled={!dirty && !rationale}
                className="rounded border border-line px-2 py-0.5 text-xs text-muted hover:border-ink/40 hover:text-ink disabled:opacity-40"
              >
                Reset
              </button>
              <button
                type="button"
                onClick={copy}
                disabled={!text}
                className="rounded border border-line px-2 py-0.5 text-xs text-muted hover:border-ink/40 hover:text-ink disabled:opacity-40"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
          <textarea
            id="redraft-input"
            data-testid="redraft-input"
            value={text}
            onChange={(e) => onText(e.target.value)}
            maxLength={2000}
            rows={4}
            spellCheck={false}
            className="w-full resize-y rounded border border-uncounted bg-paper px-2.5 py-2 font-mono text-[13px] leading-relaxed text-ink outline-none focus:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
          />
          {prefill && text === prefill ? (
            <p data-testid="redraft-tour-typed" className="mt-1 text-xs text-muted">
              Example typed by the guided tour, not reviewer input.
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="redraft-rationale" className="block text-xs font-medium text-muted">
              Why this value (rationale note, optional)
            </label>
            {exampleNote ? (
              <button
                type="button"
                data-testid="redraft-example-note"
                onClick={() => onRationale(exampleNote)}
                disabled={rationale === exampleNote}
                className="min-h-11 rounded border border-line px-2 py-0.5 text-xs text-ink hover:border-ink/40 disabled:opacity-40 sm:min-h-0"
              >
                Add an overclaiming note (tour example)
              </button>
            ) : null}
          </div>
          <textarea
            id="redraft-rationale"
            data-testid="redraft-rationale"
            value={rationale}
            onChange={(e) => onRationale(e.target.value)}
            maxLength={1000}
            rows={2}
            placeholder="e.g. aligns with the comparator arm's labelled toxicity"
            className="mt-1 w-full resize-y rounded border border-uncounted bg-paper px-2.5 py-1.5 text-sm text-ink outline-none focus:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
          />
          {exampleNote && rationale === exampleNote ? (
            <p data-testid="redraft-note-typed" className="mt-1 text-xs text-muted">
              Example note typed by the guided tour, not reviewer input.
            </p>
          ) : null}
          {result?.changed && (result.changed.operator || result.changed.value || result.changed.unit || result.changed.conditions_dropped.length > 0) ? (
            <p className="mt-2 text-xs text-muted">
              Changed from the protocol:{" "}
              {[
                result.changed.operator && "operator",
                result.changed.value && `value (${fmt(o?.value)} to ${fmt(result.parsed?.value)} ${result.parsed?.unit ?? ""})`,
                result.changed.unit && "unit",
                result.changed.conditions_dropped.length > 0 && `dropped: ${result.changed.conditions_dropped.join("; ")}`,
              ]
                .filter(Boolean)
                .join(", ")}
            </p>
          ) : null}
        </section>

        <p className="text-xs text-muted">
          Checks compare the redraft with the protocol, similar public trials, FDA guidance and NHANES. A difference is a
          review question for the team, not a finding that the change is right or wrong.
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-3" aria-live="polite">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-ink">Checks</h3>
          {result ? (
            <span className="text-xs text-muted">
              {LEVELS.map((l) => `${result.summary?.[l.level] ?? 0} ${l.title.toLowerCase()}`).join(" · ")}
            </span>
          ) : null}
          <span className={`ml-auto text-xs text-muted transition-opacity ${checking ? "opacity-100" : "opacity-0"}`} data-testid="redraft-checking">
            Checking...
          </span>
        </div>

        {error ? (
          <p role="alert" className="rounded border border-verdict/40 bg-verdict/5 px-3 py-2 text-sm text-verdict">
            {error}
          </p>
        ) : null}

        {status ? (
          <div data-testid="redraft-status" data-status={result?.verification?.status} className={`rounded-md border px-3 py-2 text-sm ${status.tone}`}>
            <span className="font-medium">{status.label}</span>
            {result?.verification?.outcome && result.verification.outcome.toLowerCase() !== result.verification.status.toLowerCase() ? <span className="text-ink/80"> · {relabel(result.verification.outcome)}</span> : null}
          </div>
        ) : result ? (
          <div data-testid="redraft-status" data-status="none" className="rounded-md border border-line px-3 py-2 text-sm text-muted">
            {result.parsed ? "Verifier: not run (the draft matches the protocol as written)." : "Verifier: not run for this text (no limit could be read)."}
          </div>
        ) : null}

        <div data-testid="redraft-flags" className={`flex flex-col gap-2 transition-opacity ${checking && result ? "opacity-60" : ""}`}>
          {result
            ? LEVELS.map(({ level, title, tone, dot }) => {
                const flags = result.flags.filter((f) => f.level === level);
                if (flags.length === 0) return null;
                return (
                  <div key={level}>
                    <p className={`mb-1 text-[11px] font-semibold uppercase tracking-wide ${dot}`}>
                      {title} ({flags.length})
                    </p>
                    <ul className="flex flex-col gap-1.5">
                      {flags.map((f, i) => (
                        <li
                          key={`${f.code}-${i}`}
                          data-testid="redraft-flag"
                          data-level={f.level}
                          data-code={f.code}
                          className={`flex gap-2 rounded border px-2.5 py-2 ${tone}`}
                        >
                          <Glyph level={f.level} className={`mt-0.5 ${dot}`} />
                          <div className="min-w-0">
                            <p className="text-sm leading-snug text-ink">{relabel(f.message)}</p>
                            <SourceLink flag={f} />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })
            : !error && <p className="text-sm text-muted">Running the first check...</p>}
        </div>

        {result && result.precedents ? (
          <Section title="Similar trials at this limit">
            {result.precedents.total === 0 ? (
              <p className="text-sm text-muted">No similar trial states this limit in a comparable form: Insufficient evidence.</p>
            ) : (
              <>
                <div className="mb-2 grid grid-cols-3 gap-1.5 text-center text-xs">
                  <div className="rounded bg-support-soft/70 px-1 py-1.5">
                    <span className="block text-base font-semibold text-ink">{result.precedents.same}</span>same
                  </div>
                  <div className="rounded bg-enrich-soft px-1 py-1.5">
                    <span className="block text-base font-semibold text-ink">{result.precedents.stricter}</span>stricter
                  </div>
                  <div className="rounded bg-look-soft/70 px-1 py-1.5">
                    <span className="block text-base font-semibold text-ink">{result.precedents.looser}</span>more permissive
                  </div>
                </div>
                <ul className="flex flex-wrap gap-1.5" data-testid="redraft-precedents">
                  {result.precedents.values.map((p) => (
                    <li key={p.nct_id} className="rounded border border-line px-1.5 py-0.5 text-xs text-muted">
                      <span className="font-medium text-ink">{p.acronym ?? p.nct_id}</span> {fmt(p.value)} {p.unit ?? ""} · {p.relation}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted">Shared limits may be carried forward from a template; a looser limit shows it was used, not that it was safe.</p>
              </>
            )}
          </Section>
        ) : null}

        {pop && limit ? (
          <Section title="US adult population (NHANES)">
            <p className="text-sm text-ink" data-testid="redraft-population">
              {pop.proposed_pct.toFixed(2)}% of US adults fall below {fmt(limit.value)} {limit.unit ?? ""}
              {result?.parsed && o && result.parsed.value !== o.value ? (
                <span className="text-muted"> (protocol limit {fmt(o.value)} {o.unit ?? ""}: {pop.current_pct.toFixed(2)}%)</span>
              ) : null}
            </p>
            <p className="mt-1 text-xs text-muted">{relabel(caveatFor(pop.caveat, criterionId))}</p>
          </Section>
        ) : null}
      </div>
    </div>
  );
}
