"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  DISPLAY_CLASSIFICATION,
  getDraft,
  getDraftPresets,
  type Draft,
  type DraftCriterion,
  type Precedent,
} from "@/lib/contracts";
import { AppHeader } from "../../components/AppHeader";
import BeforeAfter from "../../draft/BeforeAfter";
import DraftCard, { Icon, WARN } from "../../draft/DraftCard";

// Guided demo for mode B: drafting criteria from an idea. Every number on screen comes from the live draft.
const PRESET = "el3-design-time";
const EL3_NCT = "NCT03409614";
const TITLES = ["The idea", "Precedents", "Drafted", "Self-critique", "Before / after", "Guardrails"];

const PIN = "M8 1.5v13M3 4.5h10M3 11.5h10";
const CHECK = "M3 8.5l3 3 7-7";
const PEOPLE = "M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM1.5 13.5c0-2.2 1.8-4 4-4s4 1.8 4 4M11 7a1.8 1.8 0 1 0 0-3.6M12 9.6c1.5.4 2.5 1.8 2.5 3.4";
const QUESTION = "M6 6a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5M8 12v.01";

function stepFromHash(): number {
  const n = Number(window.location.hash.slice(1));
  return Number.isInteger(n) && n >= 1 && n <= TITLES.length ? n - 1 : 0;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function trialName(p: Precedent): string {
  if (p.acronym) return p.acronym;
  const tag = p.title.match(/\b(KEYNOTE-\d+|IMpower\d+|CheckMate[- ]?\d+|EMPOWER-[A-Za-z]+ ?\d*)\b/);
  return tag ? tag[1] : p.nct_id;
}

function Step({ headline, caption, children }: { headline: string; caption: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h1 className="text-balance text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{headline}</h1>
      <p className="max-w-3xl text-pretty text-muted">{caption}</p>
      <div className="mt-1">{children}</div>
    </section>
  );
}

function IdeaStep({ draft }: { draft: Draft }) {
  const { idea } = draft;
  const rows: [string, ReactNode][] = [
    ["Condition", idea.condition],
    ["Regimen", (
      <span key="regimen" className="flex flex-wrap gap-1.5">
        {idea.recognized_drugs.map((d) => (
          <span key={d} className="rounded-full border border-line px-2 py-0.5 text-sm text-ink">{d}</span>
        ))}
      </span>
    )],
    ["Drug classes", idea.classes.join(", ")],
    ["Setting", idea.setting.join(", ")],
    ["Phase", idea.phase.replace("PHASE", "Phase ")],
    ["Design date", idea.as_of ?? "today"],
  ];
  return (
    <Step
      headline="Start from an idea, not a protocol"
      caption={`The regimen and setting of EMPOWER-Lung 3 (${EL3_NCT}), as a team would have described it on ${idea.as_of}. Only trials that started before that date count, and EMPOWER-Lung 3's own protocol is left out.`}
    >
      <dl data-role="idea" className="grid max-w-3xl gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-[10rem_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="bg-paper px-4 pt-3 text-sm text-muted sm:py-3">{k}</dt>
            <dd className="bg-paper px-4 pb-3 text-ink sm:py-3">{v}</dd>
          </div>
        ))}
      </dl>
    </Step>
  );
}

function PrecedentsStep({ draft }: { draft: Draft }) {
  const cutoff = draft.idea.as_of;
  const sorted = [...draft.precedents].sort((a, b) => (a.start_date ?? "").localeCompare(b.start_date ?? ""));
  const before = sorted.filter((p) => cutoff && p.start_date && p.start_date < cutoff).length;
  return (
    <Step
      headline={`${plural(draft.precedents.length, "earlier trial")} share the regimen`}
      caption={`Matched by drug class and setting: ${before} of ${draft.precedents.length} started before ${cutoff ?? "the design date"}. ${draft.summary.drafted} criteria are drafted from their protocols.`}
    >
      <ol className="grid max-w-4xl gap-2">
        {sorted.map((p) => (
          <li key={p.nct_id} data-role="precedent" className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1 rounded-lg border border-line bg-paper px-4 py-3 sm:grid-cols-[7rem_1fr_auto]">
            <span className="text-sm tabular-nums text-muted">{p.start_date ?? "date unknown"}</span>
            <span className="min-w-0">
              <span className="font-medium text-ink">{trialName(p)}</span>
              <span className="text-muted">{trialName(p) === p.nct_id ? "" : ` · ${p.nct_id}`}{p.sponsor ? ` · ${p.sponsor}` : ""}</span>
            </span>
            <span className="col-span-2 flex flex-wrap gap-1 sm:col-span-1">
              {p.shared_classes.map((c) => (
                <span key={c} className="rounded-full bg-line px-2 py-0.5 text-xs text-ink">{c}</span>
              ))}
            </span>
          </li>
        ))}
      </ol>
    </Step>
  );
}

function CardStep({ draft, c, flagged }: { draft: Draft; c: DraftCriterion | undefined; flagged: boolean }) {
  const precedents = useMemo(() => new Map(draft.precedents.map((p) => [p.nct_id, p])), [draft]);
  if (!c) {
    return (
      <Step headline={flagged ? "Nothing flagged" : "No drafted criterion"} caption="This draft has no criterion for this step.">
        <span />
      </Step>
    );
  }
  const top = c.distribution[0];
  const verdict = DISPLAY_CLASSIFICATION[c.critique.classification];
  const headline = flagged ? `The self-critique flags ${c.label}` : c.proposed?.text ?? `${c.label}: Insufficient evidence`;
  const caption = flagged
    ? `Each draft is critiqued like a finished protocol. ${c.label} gets "${verdict}" (support ${c.critique.scores.support}, challenge ${c.critique.scores.challenge}): a question for the team, not a mistake.`
    : top
      ? `${top.count} of ${draft.precedents.length} precedents used ${top.operator}${top.value} ${top.unit}. The verifier re-checks the value against their protocol text before it is shown.`
      : "No precedent states a value, so no value is proposed.";
  return (
    <Step headline={headline} caption={caption}>
      <div className="max-w-4xl" data-role={flagged ? "flagged-card" : "drafted-card"}>
        <DraftCard c={c} precedents={precedents} />
      </div>
    </Step>
  );
}

function GuardrailsStep({ draft }: { draft: Draft }) {
  const items: [string, string, string][] = [
    [PIN, "Values come only from verified precedents", `${draft.summary.drafted} drafted, ${draft.summary.insufficient} without a verified precedent.`],
    [QUESTION, "Otherwise: Insufficient evidence", "No precedent, no proposed value. Nothing is filled in by a model."],
    [WARN, "Differences are review questions", "Agreement among precedents may be template carry-forward, not proof a value is right."],
    [PEOPLE, "The team decides", "ProtocolOS prepares the rationale; the protocol team makes the call."],
  ];
  return (
    <Step
      headline="Suggestions with a traceable rationale"
      caption="Rationale in non-public sources (preclinical toxicology, internal data) cannot be seen by ProtocolOS."
    >
      <ul className="grid max-w-4xl gap-3 sm:grid-cols-2">
        {items.map(([icon, title, body]) => (
          <li key={title} className="flex gap-3 rounded-lg border border-line bg-paper p-4">
            <span className="mt-0.5 text-ink"><Icon d={icon} className="h-4 w-4" /></span>
            <span>
              <span className="block font-medium text-ink">{title}</span>
              <span className="block text-sm text-muted">{body}</span>
            </span>
          </li>
        ))}
      </ul>
      <a
        href={`../draft?preset=${PRESET}`}
        className="mt-5 inline-flex items-center gap-2 rounded-md bg-ink px-4 py-2 text-paper hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        <Icon d={CHECK} className="h-4 w-4" />
        Open the full draft
      </a>
    </Step>
  );
}

export default function DraftTour() {
  const [step, setStep] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [failed, setFailed] = useState(false);

  const go = useCallback((next: number) => {
    window.location.hash = String(Math.min(Math.max(next, 0), TITLES.length - 1) + 1);
  }, []);

  useEffect(() => {
    const sync = () => setStep(stepFromHash());
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    let live = true;
    getDraftPresets()
      .then((ps) => {
        const p = ps.find((x) => x.id === PRESET);
        return p ? getDraft(p.draft_id) : Promise.reject(new Error("preset missing"));
      })
      .then((d) => live && setDraft(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
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

  const picks = useMemo(() => {
    const drafted = draft?.criteria.filter((c) => c.status === "drafted") ?? [];
    return {
      shown: drafted.find((c) => c.critique.classification === "Evidence supports retaining") ?? drafted[0],
      flagged: drafted.find((c) => c.critique.classification !== "Evidence supports retaining"),
    };
  }, [draft]);

  if (step === null) return null;

  let body: ReactNode;
  if (failed) body = <p className="text-muted">Could not load the EMPOWER-Lung 3 design-time draft from the engine.</p>;
  else if (!draft) body = <p className="text-muted">Loading the draft…</p>;
  else if (step === 0) body = <IdeaStep draft={draft} />;
  else if (step === 1) body = <PrecedentsStep draft={draft} />;
  else if (step === 2) body = <CardStep draft={draft} c={picks.shown} flagged={false} />;
  else if (step === 3) body = <CardStep draft={draft} c={picks.flagged} flagged />;
  else if (step === 4)
    body = (
      <Step
        headline="Draft versus EMPOWER-Lung 3 as written"
        caption="The same criteria side by side with the protocol the team actually wrote. Each difference is a question to review."
      >
        <div className="max-w-5xl"><BeforeAfter draft={draft} nct={EL3_NCT} /></div>
      </Step>
    );
  else body = <GuardrailsStep draft={draft} />;

  return (
    <>
      <AppHeader mode="tour" />
      <main className="mx-auto flex max-w-6xl flex-col px-4 py-4 sm:px-6">
        <nav aria-label="Demo steps" className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <ol className="flex flex-1 flex-wrap items-center gap-2">
            {TITLES.map((t, i) => (
              <li key={t}>
                <button
                  type="button"
                  onClick={() => go(i)}
                  aria-current={i === step ? "step" : undefined}
                  className={`flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors duration-150 ${i === step ? "text-ink" : "text-muted hover:text-ink"}`}
                >
                  <span aria-hidden className={`h-2 w-2 rounded-full ${i === step ? "bg-ink" : i < step ? "bg-muted" : "bg-line"}`} />
                  <span className={i === step ? "font-medium" : ""}>{t}</span>
                </button>
              </li>
            ))}
          </ol>
          <span className="text-sm tabular-nums text-muted">{step + 1} / {TITLES.length}</span>
          <a
            href={`../draft?preset=${PRESET}`}
            data-testid="tour-exit"
            className="rounded-md px-3 py-1 text-sm text-ink hover:bg-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
          >
            Exit to the draft
          </a>
        </nav>

        <div key={step} data-testid="tour-step" data-step={step + 1} className="mt-5 flex flex-1 flex-col">
          {body}
        </div>

        <footer className="mt-6 flex items-center justify-between border-t border-line pt-3">
          <button
            type="button"
            data-testid="tour-back"
            onClick={() => go(step - 1)}
            disabled={step === 0}
            className="rounded-md px-4 py-2 text-ink transition-colors duration-150 hover:bg-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:invisible"
          >
            Back
          </button>
          <span className="hidden text-sm text-muted sm:inline">Arrow keys move between steps</span>
          <button
            type="button"
            data-testid="tour-next"
            onClick={() => go(step + 1)}
            disabled={step === TITLES.length - 1}
            className="rounded-md bg-ink px-5 py-2 text-paper transition-opacity duration-150 hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:invisible"
          >
            Next
          </button>
        </footer>
      </main>
    </>
  );
}
