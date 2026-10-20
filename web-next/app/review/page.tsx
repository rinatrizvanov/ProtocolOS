"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from "react";
import { CACHED_TRIALS, EngineError, NCT, getReview, needsKey, searchTrials, type Classification, type Criterion, type Review, type Selection, type TrialHit } from "@/lib/api";
import { DISPLAY_CLASSIFICATION } from "@/lib/contracts";
import { useApi } from "@/lib/useApi";
import { addedTrials, rememberTrial, useModelKey } from "@/lib/visitor";
import { AppHeader } from "../components/AppHeader";
import { Pending } from "../components/Frame";
import { ChatIcon, CompareIcon, GavelIcon, InfoIcon, PenIcon } from "../components/Icons";
import { MissingCriteria } from "../components/MissingCriteria";
import { ModelKeyForm } from "../components/ModelKeyForm";
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

// The selection lives only in the URL (?nct=&c=&tab=), so a reload keeps it. Any NCT id is accepted: a preloaded trial
// opens at once, another one is analysed with the visitor's key. A deep link with a malformed id or an unknown criterion
// falls back, and `missing` / `missingc` carry what was asked for so the page can say so.
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
  if (next.missing != null) params.set("missing", next.missing);
  if (next.missingCriterion != null) params.set("missingc", next.missingCriterion);
  // Keep the current path so the page works at /review, /review/ and under any mount point.
  const url = `${window.location.pathname}?${params.toString()}`;
  if (replace) window.history.replaceState(null, "", url);
  else window.history.pushState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const clip = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n)}…` : s);
// A notice echoes only what looks like a trial or criterion id; anything else in the URL is not repeated on the page.
const echo = (s: string | null): string | null => (s === null ? null : /^[A-Za-z0-9_-]{1,24}$/.test(s.trim()) ? s.trim() : "");

function parseSelection(search: string): Parsed {
  const params = new URLSearchParams(search);
  const raw = params.get("nct") ?? NCT;
  const asked = raw.trim().toUpperCase();
  const rawTab = params.get("tab");
  const tab = (TABS.find((t) => t.id === rawTab)?.id ?? "rationale") as TabId;
  const missing = echo(params.get("missing"));
  const missingCriterion = echo(params.get("missingc"));
  return /^NCT\d{8}$/.test(asked)
    ? { nct: asked, criterionId: params.get("c"), tab, missing, missingCriterion }
    : { nct: NCT, criterionId: null, tab, missing: echo(raw), missingCriterion: null };
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

const isPreloaded = (nct: string) => (CACHED_TRIALS as readonly string[]).includes(nct);

// Option labels name each trial by its registry title; the other trials' reviews load after the current one is shown
// (they are cached per page load, so switching to one is then instant). Added trials are asked for without the key, so a
// trial the server no longer has (after a redeploy) is never re-analysed just to show its title.
function useTrialTitles(trials: string[]): Record<string, string> {
  const [titles, setTitles] = useState<Record<string, string>>({});
  const list = trials.join(",");
  useEffect(() => {
    let live = true;
    const id = window.setTimeout(() => {
      for (const nct of list.split(",")) {
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
  }, [list]);
  return titles;
}

function TrialPicker({ nct, tab }: { nct: string; tab: TabId }) {
  // The page renders only in the browser (ReviewPage), and ReviewBody remounts per trial, so one read per mount is enough.
  const [added] = useState(addedTrials);
  const extra = [...new Set([...added, ...(isPreloaded(nct) ? [] : [nct])])].filter((id) => !isPreloaded(id));
  const titles = useTrialTitles([...CACHED_TRIALS, ...extra]);
  const label = (id: string) => (titles[id] ? `${id} · ${clip(titles[id], 48)}` : id);
  return (
    <div className="flex min-w-0 flex-col gap-2 lg:items-end">
      <label className="flex min-w-0 flex-col gap-1 text-sm text-muted sm:flex-row sm:items-center sm:gap-2">
        <span className="shrink-0">Trial</span>
        <select
          data-testid="trial-picker"
          value={nct}
          onChange={(e) => navigate({ nct: e.target.value, criterionId: null, tab })}
          className={`min-h-11 w-full min-w-0 rounded-md border ${fieldBorder} bg-paper px-2 py-1 text-ink tabular-nums sm:min-h-9 sm:w-80 ${focusRing}`}
        >
          <optgroup label="Preloaded worked examples">
            {CACHED_TRIALS.map((id) => (
              <option key={id} value={id}>
                {label(id)}
              </option>
            ))}
          </optgroup>
          {extra.length ? (
            <optgroup label="Added in this browser">
              {extra.map((id) => (
                <option key={id} value={id}>
                  {label(id)}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </label>
      <AddTrial />
    </div>
  );
}

type Search = { status: "idle" } | { status: "busy" } | { status: "error"; message: string } | { status: "ready"; hits: TrialHit[] };

// An NCT id opens that trial (the review asks for the visitor's key when the server has not analysed it yet); any
// other text is a plain-language search of the phase 3 oncology trials with a posted protocol.
function AddTrial() {
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const [search, setSearch] = useState<Search>({ status: "idle" });
  function open(id: string) {
    setValue("");
    setSearch({ status: "idle" });
    navigate({ nct: id, criterionId: null, tab: "rationale" });
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const text = value.trim();
    const id = text.toUpperCase();
    if (/^NCT\d{8}$/.test(id)) {
      setInvalid(false);
      open(id);
      return;
    }
    if (/^NCT\d*$/.test(id) || text.length < 3) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setSearch({ status: "busy" });
    searchTrials(text).then(
      (r) => setSearch({ status: "ready", hits: r.results }),
      (err: unknown) => setSearch({ status: "error", message: err instanceof EngineError ? (err.detail ?? err.message) : String(err) }),
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-2 lg:items-end">
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-1 text-sm text-muted sm:flex-row sm:items-center sm:gap-2" aria-label="Find or add a trial">
        <label htmlFor="add-trial" className="shrink-0">
          Find or add a trial
        </label>
        <div className="flex min-w-0 gap-2">
          <input
            id="add-trial"
            data-testid="add-trial-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="NCT number or a description"
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? "add-trial-error" : undefined}
            className={`min-h-11 w-full min-w-0 rounded-md border ${invalid ? "border-verdict" : fieldBorder} bg-paper px-2 py-1 text-ink tabular-nums sm:min-h-9 sm:w-72 ${focusRing}`}
          />
          <button
            type="submit"
            data-testid="add-trial-submit"
            disabled={!value.trim()}
            className={`min-h-11 shrink-0 rounded-md border border-ink px-3 py-1 text-ink transition-opacity duration-150 disabled:opacity-40 sm:min-h-9 ${focusRing}`}
          >
            {/^nct\d{8}$/i.test(value.trim()) ? "Analyse" : "Search"}
          </button>
        </div>
        {invalid ? (
          <p id="add-trial-error" role="alert" className="text-xs text-verdict">
            Expected an NCT id with 8 digits, or at least 3 characters to search.
          </p>
        ) : null}
      </form>
      <TrialHits search={search} onOpen={open} onHide={() => setSearch({ status: "idle" })} />
    </div>
  );
}

function TrialHits({ search, onOpen, onHide }: { search: Search; onOpen: (id: string) => void; onHide: () => void }) {
  if (search.status === "idle") return null;
  if (search.status === "busy") return <p className="text-sm text-muted">Searching…</p>;
  if (search.status === "error") return <p role="alert" className="text-sm text-verdict">Search failed: {search.message}</p>;
  if (!search.hits.length) return <p className="text-sm text-muted">No similar trial with a posted protocol.</p>;
  return (
    <ul data-testid="trial-hits" aria-label="Similar trials" className="flex w-full min-w-0 flex-col gap-1 sm:w-[32rem]">
      {search.hits.map((h) => (
        <li key={h.nct_id}>
          <button
            type="button"
            data-testid="trial-hit"
            onClick={() => onOpen(h.nct_id)}
            className={`flex w-full min-w-0 flex-col items-start gap-0.5 rounded-md border border-line bg-white/70 px-3 py-2 text-left hover:border-ink ${focusRing}`}
          >
            <span className="w-full truncate text-sm font-medium text-ink">
              {h.acronym ? `${h.acronym}: ` : ""}
              {h.title}
            </span>
            <span className="text-xs tabular-nums text-muted">
              {h.nct_id}
              {h.start_date ? ` · started ${h.start_date}` : ""} ·{" "}
              {isPreloaded(h.nct_id) || h.analysed ? <span className="text-support">opens now</span> : "analysis needs your key"}
            </span>
          </button>
        </li>
      ))}
      <li className="flex items-start justify-between gap-3 text-xs text-muted">
        <span>Nearest by meaning in the semantic index of phase 3 oncology trials with a posted protocol; nearness is not comparability.</span>
        <button type="button" data-testid="trial-hits-hide" onClick={onHide} className={`shrink-0 rounded px-1 text-ink underline underline-offset-2 ${focusRing}`}>
          Hide results
        </button>
      </li>
    </ul>
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
          No comparable trial was found for this protocol, so no limit here has a precedent to compare with. Classifications here
          come from the other scoring rules: drug links in the curated pharmacology table and FDA guidance specific to a
          criterion.
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
  if (missing === null && missingCriterion === null) return null;
  return (
    <p data-testid="deeplink-notice" role="status" className="rounded-md border border-look bg-look-soft/50 px-3 py-2 text-sm text-ink">
      {missing !== null ? `${missing || "The requested trial"} is not a ClinicalTrials.gov id like ${NCT}; showing ${NCT}.` : null}
      {missing !== null && missingCriterion !== null ? " " : null}
      {missingCriterion !== null
        ? `This trial has no criterion ${missingCriterion ? `"${missingCriterion}"` : "by that name"}; showing ${fallbackLabel ?? "the first criterion"}.`
        : null}
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

// A trial the server has not analysed yet: say what happens, ask for the key, then load it with the key.
function KeyGate({ nct, error, tab, onReady }: { nct: string; error: EngineError; tab: TabId; onReady: () => void }) {
  const invalid = error.code !== "key_required";
  return (
    <section data-testid="trial-key-gate" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
        <div className="flex max-w-2xl flex-col gap-1">
          <h1 className="text-xl font-semibold tracking-tight text-ink sm:text-2xl">Analyse {nct}</h1>
          <p className="text-base text-ink">
            {nct} is not one of the {CACHED_TRIALS.length} preloaded trials. ProtocolOS can analyse it now: it reads the
            registry record and the protocol PDF posted on ClinicalTrials.gov, finds comparable trials that started earlier, and
            scores each criterion with the same rules. This takes one to two minutes.
          </p>
        </div>
        <TrialPicker nct={nct} tab={tab} />
      </div>
      {invalid && error.detail ? (
        <p role="alert" className="rounded-md border border-verdict/40 bg-white/70 px-3 py-2 text-sm text-verdict">
          {error.detail}
        </p>
      ) : null}
      <ModelKeyForm
        autoFocus
        purpose="New analyses run on the demo server. To keep it open to everyone, starting one needs your own OpenAI or Anthropic key; the analysis itself uses no model tokens, and the same key answers the Ask tab's model questions."
        onReady={onReady}
      />
    </section>
  );
}

function Limited({ nct, error, tab, onRetry }: { nct: string; error: EngineError; tab: TabId; onRetry: () => void }) {
  return (
    <section role="alert" data-testid="trial-limited" className="flex max-w-2xl flex-col items-start gap-3">
      <h1 className="text-xl font-semibold text-ink">{nct} could not be analysed right now.</h1>
      <p className="text-base text-ink">{error.detail ?? error.message}</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={onRetry} className={`min-h-11 rounded-md bg-ink px-5 py-2 text-base text-paper ${focusRing}`}>
          Try again
        </button>
        <button type="button" onClick={() => navigate({ nct: NCT, criterionId: null, tab })} className={`min-h-11 rounded-md border border-ink px-5 py-2 text-base text-ink ${focusRing}`}>
          Open a preloaded trial
        </button>
      </div>
    </section>
  );
}

// What an added trial's review could and could not read, said before the criteria.
function AddedTrialNotes({ review }: { review: Review }) {
  const noProtocol = (review.target.study.protocol_docs ?? []).length === 0;
  const noCriteria = review.reviews.length === 0;
  return (
    <div className="flex flex-col gap-2">
      <p data-testid="added-trial-note" className="-mt-1 text-xs text-muted">
        Added trial: analysed on this server{review.computed_at ? ` on ${review.computed_at}` : ""} with the same rules as the
        preloaded examples. Anyone with this link can open the result.
      </p>
      {noProtocol ? (
        <p role="note" data-testid="no-protocol" className="rounded-md border border-look bg-look-soft/50 px-3 py-2 text-sm text-ink">
          No protocol PDF is posted on ClinicalTrials.gov for this trial, so the criteria come from the registry text, which rarely
          states lab thresholds.
        </p>
      ) : null}
      {noCriteria ? (
        <p role="note" data-testid="no-criteria" className="rounded-md border border-look bg-look-soft/50 px-3 py-2 text-sm text-ink">
          No eligibility criterion the extractor covers (lab limits, ECOG, washouts) was found{noProtocol ? "" : " in the posted protocol"}.
          The extractor is rule-based and misses unusual layouts; this does not mean the protocol has no such criteria.
        </p>
      ) : null}
    </div>
  );
}

function ReviewBody({ nct, criterionId, tab, missing, missingCriterion }: Parsed) {
  const [attempt, setAttempt] = useState(0);
  const key = useModelKey();
  const preloaded = isPreloaded(nct);
  // An added trial is asked for with the key when one is set: if the server has not analysed it, that starts the analysis.
  const state = useApi(() => getReview(nct, !preloaded && key !== null), attempt);
  const review = state.status === "ready" ? state.data : null;
  const row = review?.reviews.find((r) => r.criterion.id === criterionId);
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  useEffect(() => {
    if (!row) return;
    document.title = `${row.criterion.label} ${threshold(row.criterion)} · ${nct} · ProtocolOS`;
  }, [row, nct]);

  useEffect(() => {
    if (review && !preloaded) rememberTrial(nct);
  }, [review, preloaded, nct]);

  const retry = () => setAttempt((a) => a + 1);
  if (state.status === "loading")
    return (
      <Pending
        label={
          preloaded || key === null
            ? "Loading the review…"
            : `Analysing ${nct}: reading the registry record, the posted protocol and comparable trials. A new trial can take one to two minutes.`
        }
      />
    );
  if (state.status === "error") {
    const err = state.error;
    if (needsKey(err)) return <KeyGate nct={nct} error={err as EngineError} tab={tab} onReady={retry} />;
    if (err instanceof EngineError && err.code && err.status !== 0) return <Limited nct={nct} error={err} tab={tab} onRetry={retry} />;
    if (err instanceof EngineError && err.status === 404 && !preloaded)
      return <Limited nct={nct} error={new EngineError(err.message, 404, "not_found", `ClinicalTrials.gov has no record ${nct}, or it could not be read.`)} tab={tab} onRetry={retry} />;
    return <EngineDown message={state.message} onRetry={retry} />;
  }
  const data = state.data;
  const first = data.reviews[0]?.criterion;

  return (
    <>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
        <TrialHeading review={data} />
        <TrialPicker nct={nct} tab={tab} />
      </div>
      {preloaded ? (
        <p className="-mt-1 text-xs text-muted">
          Finishing a trial: worked examples from the posted protocols of {CACHED_TRIALS.length} completed oncology trials, reviewed
          retrospectively.
        </p>
      ) : (
        <AddedTrialNotes review={data} />
      )}
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
