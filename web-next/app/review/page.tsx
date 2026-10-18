"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { CACHED_TRIALS, NCT, getReview, type Classification, type Criterion, type Review, type Selection } from "@/lib/api";
import { DISPLAY_CLASSIFICATION } from "@/lib/contracts";
import { useApi } from "@/lib/useApi";
import { AppHeader } from "../components/AppHeader";
import { Pending } from "../components/Frame";
import { ChatIcon, CompareIcon, GavelIcon, InfoIcon, PenIcon } from "../components/Icons";
import { MissingCriteria } from "../components/MissingCriteria";
import { RationalePanel } from "../components/RationalePanel";
import Redraft from "../screens/Redraft";
import Screen2 from "../screens/Screen2";
import Screen4 from "../screens/Screen4";
import Screen7 from "../screens/Screen7";

const TABS = [
  { id: "rationale", title: "Rationale", Icon: InfoIcon, render: (s: Selection) => <RationalePanel {...s} /> },
  { id: "compare", title: "Compare", Icon: CompareIcon, render: (s: Selection) => <Screen2 {...s} detailed /> },
  { id: "ask", title: "Ask", Icon: ChatIcon, render: (s: Selection) => <Screen4 {...s} variant="app" /> },
  { id: "verify", title: "Redraft", Icon: PenIcon, render: (s: Selection) => <Redraft {...s} /> },
  { id: "decide", title: "Decide", Icon: GavelIcon, render: (s: Selection) => <Screen7 {...s} detailed /> },
] as const;
type TabId = (typeof TABS)[number]["id"];

const CLASSES: Classification[] = ["Review recommended", "Evidence supports retaining", "Insufficient evidence"];
const TONE: Record<Classification, string> = {
  "Review recommended": "border-look",
  "Evidence supports retaining": "border-support",
  "Insufficient evidence": "border-uncounted",
};
const DOT: Record<Classification, string> = {
  "Review recommended": "bg-look",
  "Evidence supports retaining": "bg-support",
  "Insufficient evidence": "bg-uncounted",
};

const fieldBorder = "border-uncounted";
const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink";

// The selection lives only in the URL (?nct=&c=&tab=), so a reload keeps it; only cached trials are accepted. A deep link
// to an uncached trial or an unknown criterion falls back, and `missing` / `missingc` carry what was asked for so the
// page can say so.
type Parsed = { nct: string; criterionId: string | null; tab: TabId; missing: string | null; missingCriterion: string | null };

function subscribeToUrl(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

// User actions push a history entry, so Back returns to the previous selection; the automatic fallback replaces it.
function navigate(next: Omit<Parsed, "missing" | "missingCriterion"> & Partial<Pick<Parsed, "missing" | "missingCriterion">>, replace = false) {
  const params = new URLSearchParams({ nct: next.nct });
  if (next.criterionId) params.set("c", next.criterionId);
  if (next.tab !== "rationale") params.set("tab", next.tab);
  if (next.missing) params.set("missing", next.missing);
  if (next.missingCriterion) params.set("missingc", next.missingCriterion);
  // Keep the current path so the page works at /review, /review/ and under any mount point.
  const url = `${window.location.pathname}?${params.toString()}`;
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);

function parseSelection(search: string): Parsed {
  const params = new URLSearchParams(search);
  const raw = params.get("nct") ?? NCT;
  const asked = raw.trim().toUpperCase();
  const rawTab = params.get("tab");
  const tab = (TABS.find((t) => t.id === rawTab)?.id ?? "rationale") as TabId;
  const missing = params.get("missing");
  const missingCriterion = params.get("missingc");
  return (CACHED_TRIALS as readonly string[]).includes(asked)
    ? { nct: asked, criterionId: params.get("c"), tab, missing, missingCriterion }
    : { nct: NCT, criterionId: null, tab, missing: clip(raw), missingCriterion: null };
}

function threshold(c: Criterion): string {
  return c.value_norm === null ? "no numeric limit" : `${c.operator} ${c.value_norm}${c.unit_norm ? ` ${c.unit_norm}` : ""}`;
}

const PHASE = (p: string) => p.replace(/^PHASE(\d)$/i, "Phase $1").replace(/^EARLY_PHASE1$/i, "Early phase 1");
const STATUS = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");

function CriteriaList({
  review,
  nct,
  selected,
  tab,
  missing,
  missingCriterion,
}: {
  review: Review;
  nct: string;
  selected: string | null;
  tab: TabId;
  missing: string | null;
  missingCriterion: string | null;
}) {
  const first = review.reviews[0]?.criterion.id;
  // No ?c= or one this review does not have: select the first criterion, and remember an unknown one for the notice.
  const known = review.reviews.some((r) => r.criterion.id === selected);
  useEffect(() => {
    if (!known && first)
      navigate({ nct, criterionId: first, tab, missing, missingCriterion: selected ? clip(selected) : missingCriterion }, true);
  }, [nct, known, first, tab, selected, missing, missingCriterion]);

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-ink">
        Criteria <span className="font-normal tabular-nums text-muted">({review.reviews.length})</span>
      </h2>
      <ul className="flex flex-col gap-0.5">
        {review.reviews.map((r) => (
          <li key={r.criterion.id}>
            <button
              type="button"
              data-testid="criterion-item"
              data-criterion={r.criterion.id}
              data-classification={r.classification}
              aria-current={r.criterion.id === selected ? "true" : undefined}
              onClick={() => navigate({ nct, criterionId: r.criterion.id, tab })}
              className={`w-full rounded-r-md border-l-4 px-3 py-1.5 text-left transition-colors duration-150 ${focusRing} ${TONE[r.classification]} ${
                r.criterion.id === selected ? "bg-line text-ink" : "text-muted hover:bg-line/50 hover:text-ink"
              }`}
            >
              <span className="block text-sm font-medium text-ink">{r.criterion.label}</span>
              <span className="block text-xs tabular-nums">
                {r.criterion.operator} {r.criterion.value_norm} {r.criterion.unit_norm}
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 text-xs text-ink">
                <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${DOT[r.classification]}`} />
                {DISPLAY_CLASSIFICATION[r.classification]}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Phones get the panel first: this picker switches criteria above the tabs, and the full list follows the panel.
function CriterionPicker({ review, nct, selected, tab }: { review: Review; nct: string; selected: string; tab: TabId }) {
  return (
    <label className="flex flex-col gap-1 pb-3 text-sm text-muted md:hidden">
      Criterion
      <select
        data-testid="criterion-picker"
        value={selected}
        onChange={(e) => navigate({ nct, criterionId: e.target.value, tab })}
        className={`min-h-11 w-full rounded-md border ${fieldBorder} bg-paper px-2 py-1.5 text-ink ${focusRing}`}
      >
        {review.reviews.map((r) => (
          <option key={r.criterion.id} value={r.criterion.id}>
            {`${[r.criterion.label, r.criterion.operator, r.criterion.value_norm, r.criterion.unit_norm].filter((x) => x !== null && x !== "").join(" ")} (${DISPLAY_CLASSIFICATION[r.classification]})`}
          </option>
        ))}
      </select>
    </label>
  );
}

// Option labels name each trial by its registry title; the other trials' reviews load after the current one is shown
// (they are cached per page load, so switching to one is then instant).
function useTrialTitles(): Record<string, string> {
  const [titles, setTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    const id = window.setTimeout(() => {
      for (const nct of CACHED_TRIALS) {
        getReview(nct).then(
          (r) => live && setTitles((prev) => ({ ...prev, [nct]: r.target.study.title })),
          () => undefined,
        );
      }
    }, 600);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, []);
  return titles;
}

function TrialPicker({ nct, tab }: { nct: string; tab: TabId }) {
  const titles = useTrialTitles();
  return (
    <label className="flex min-w-0 flex-col gap-1 text-sm text-muted sm:flex-row sm:items-center sm:gap-2">
      <span className="shrink-0">Trial</span>
      <select
        data-testid="trial-picker"
        value={nct}
        onChange={(e) => navigate({ nct: e.target.value, criterionId: null, tab })}
        className={`min-h-11 w-full min-w-0 rounded-md border ${fieldBorder} bg-paper px-2 py-1 text-ink tabular-nums sm:min-h-9 sm:w-80 ${focusRing}`}
      >
        {CACHED_TRIALS.map((id) => (
          <option key={id} value={id}>
            {titles[id] ? `${id} · ${clip(titles[id], 48)}` : id}
          </option>
        ))}
      </select>
    </label>
  );
}

function TrialHeading({ review }: { review: Review }) {
  const s = review.target.study;
  const meta = [
    s.nct_id,
    s.sponsor,
    ...(s.phases ?? []).map(PHASE),
    s.start_date ? `started ${s.start_date}` : null,
    s.status ? STATUS(s.status) : null,
  ].filter(Boolean);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h1 data-testid="trial-title" className="line-clamp-2 text-balance text-xl font-semibold tracking-tight text-ink sm:text-2xl" title={s.title}>
        {s.acronym ? `${s.acronym}: ` : ""}
        {s.title}
      </h1>
      <p data-testid="trial-meta" className="text-sm text-muted">
        {meta.map((m, i) => (
          <span key={`${m}-${i}`}>
            {i > 0 ? " · " : ""}
            {i === 0 && s.registry_url ? (
              <a href={s.registry_url} target="_blank" rel="noreferrer" className="tabular-nums text-ink underline decoration-uncounted underline-offset-2 hover:decoration-ink">
                {m}
              </a>
            ) : (
              m
            )}
          </span>
        ))}
      </p>
    </div>
  );
}

function SummaryStrip({ review }: { review: Review }) {
  const total = review.reviews.length;
  const comparators = review.comparators.length;
  return (
    <div className="flex flex-col gap-2">
      <ul data-testid="review-summary" aria-label="This review at a glance" className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-ink">
        <li className="font-medium tabular-nums">{total} criteria</li>
        {CLASSES.map((c) => {
          const n = review.reviews.filter((r) => r.classification === c).length;
          return (
            <li key={c} data-classification={c} className="flex items-center gap-1.5">
              <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${DOT[c]}`} />
              <span className="font-semibold tabular-nums">{n}</span> {DISPLAY_CLASSIFICATION[c]}
            </li>
          );
        })}
        <li className="tabular-nums text-muted">
          {comparators} comparable {comparators === 1 ? "trial" : "trials"}
        </li>
      </ul>
      {comparators === 0 ? (
        <p data-testid="no-comparators" role="note" className="rounded-md border border-uncounted bg-uncounted-soft px-3 py-2 text-sm text-ink">
          No comparable trial was found for this protocol, so no limit here has a precedent to compare with. Classifications come
          from the regimen and protocol rules alone.
        </p>
      ) : null}
    </div>
  );
}

function EngineDown({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section role="alert" data-testid="engine-down" className="flex max-w-2xl flex-col items-start gap-3 rounded-lg border border-verdict/40 bg-white/70 p-5">
      <h1 className="text-xl font-semibold text-ink">The ProtocolOS engine did not answer.</h1>
      <p className="text-base text-ink">The demo server may be starting; try again in a few seconds.</p>
      <button
        type="button"
        data-testid="retry"
        onClick={onRetry}
        className="min-h-11 rounded-md bg-ink px-5 py-2 text-base text-paper focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        Try again
      </button>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer select-none py-1 text-ink">Technical detail</summary>
        <p className="break-words">{message}</p>
      </details>
    </section>
  );
}

function Notice({ missing, missingCriterion, fallbackLabel }: { missing: string | null; missingCriterion: string | null; fallbackLabel: string | null }) {
  if (!missing && !missingCriterion) return null;
  return (
    <p data-testid="deeplink-notice" role="status" className="rounded-md border border-look bg-look-soft/50 px-3 py-2 text-sm text-ink">
      {missing ? `${missing} is not one of the ${CACHED_TRIALS.length} cached trials; showing ${NCT}.` : null}
      {missing && missingCriterion ? " " : null}
      {missingCriterion ? `This trial has no criterion "${missingCriterion}"; showing ${fallbackLabel ?? "the first criterion"}.` : null}
    </p>
  );
}

function Tabs({ nct, criterionId, active }: { nct: string; criterionId: string; active: TabId }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = TABS.findIndex((t) => t.id === active);
  // Roving focus: arrows, Home and End move between tabs and select them (automatic activation).
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const last = TABS.length - 1;
    const to =
      e.key === "ArrowRight" ? (index + 1) % TABS.length : e.key === "ArrowLeft" ? (index + last) % TABS.length : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (to === null) return;
    e.preventDefault();
    navigate({ nct, criterionId, tab: TABS[to].id });
    refs.current[to]?.focus();
  };
  return (
    <div role="tablist" aria-label="Views" className="flex gap-1 border-b border-line">
      {TABS.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          id={`tab-${t.id}`}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          aria-controls="review-panel"
          tabIndex={t.id === active ? 0 : -1}
          data-testid={`tab-${t.id}`}
          onClick={() => navigate({ nct, criterionId, tab: t.id })}
          onKeyDown={onKey}
          className={`-mb-px flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-1 border-b-2 px-1 py-2 text-xs transition-colors duration-150 ${focusRing} sm:flex-none sm:flex-row sm:gap-1.5 sm:px-3 sm:text-sm ${
            t.id === active ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink"
          }`}
        >
          <t.Icon />
          {t.title}
        </button>
      ))}
    </div>
  );
}

function ReviewBody({ nct, criterionId, tab, missing, missingCriterion }: Parsed) {
  const [attempt, setAttempt] = useState(0);
  const state = useApi(() => getReview(nct), attempt);
  const review = state.status === "ready" ? state.data : null;
  const row = review?.reviews.find((r) => r.criterion.id === criterionId);
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  useEffect(() => {
    if (!row) return;
    document.title = `${row.criterion.label} ${threshold(row.criterion)} · ${nct} · ProtocolOS`;
  }, [row, nct]);

  if (state.status === "loading") return <Pending label="Loading the review…" />;
  if (state.status === "error") return <EngineDown message={state.message} onRetry={() => setAttempt((a) => a + 1)} />;
  const data = state.data;
  const first = data.reviews[0]?.criterion;

  return (
    <>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
        <TrialHeading review={data} />
        <TrialPicker nct={nct} tab={tab} />
      </div>
      <p className="-mt-1 text-xs text-muted">
        Finishing a trial: worked examples from the posted protocols of {CACHED_TRIALS.length} completed oncology trials, reviewed
        retrospectively.
      </p>
      <Notice missing={missing} missingCriterion={missingCriterion} fallbackLabel={first ? `${first.label} ${threshold(first)}` : null} />
      <SummaryStrip review={data} />

      <div className="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
        <nav aria-label="Criteria" className="order-last flex flex-col gap-4 md:order-none">
          <CriteriaList review={data} nct={nct} selected={criterionId} tab={tab} missing={missing} missingCriterion={missingCriterion} />
          <MissingCriteria nct={nct} />
        </nav>
        {criterionId && row ? (
          <section aria-label="Criterion details" className="flex min-w-0 flex-col">
            <CriterionPicker review={data} nct={nct} selected={criterionId} tab={tab} />
            <h2 data-testid="criterion-heading" className="sr-only pb-2 text-xl font-semibold tracking-tight text-ink md:not-sr-only">
              {row.criterion.label} <span className="tabular-nums text-muted">{threshold(row.criterion)}</span>
            </h2>
            <Tabs nct={nct} criterionId={criterionId} active={active.id} />
            <div
              key={`${nct}:${criterionId}:${active.id}`}
              id="review-panel"
              role="tabpanel"
              aria-labelledby={`tab-${active.id}`}
              tabIndex={-1}
              data-tab={active.id}
              className="flex flex-1 flex-col pt-4 focus:outline-none"
            >
              {active.render({ nct, criterionId })}
            </div>
          </section>
        ) : null}
      </div>
    </>
  );
}

export default function ReviewPage() {
  const search = useSyncExternalStore(subscribeToUrl, () => window.location.search, () => null);
  if (search === null) return null;
  const parsed = parseSelection(search);

  return (
    <>
      <a
        href="#review-panel"
        className="sr-only z-40 rounded-md bg-ink px-4 py-2 text-paper focus:not-sr-only focus:fixed focus:left-4 focus:top-2"
      >
        Skip to criterion details
      </a>
      <AppHeader mode="review" />
      <main className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6">
        <ReviewBody key={parsed.nct} {...parsed} />
      </main>
    </>
  );
}
