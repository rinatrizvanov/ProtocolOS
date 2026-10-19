"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, getDraftPresets, getDraftVocabulary, type Draft, type DraftCriterion, type DraftPreset, type DraftVocabulary, type Idea } from "@/lib/contracts";
import { keyHeaders, sessionId, useModelKey } from "@/lib/visitor";
import { AppHeader } from "../components/AppHeader";
import { ModelKeyForm } from "../components/ModelKeyForm";
import BeforeAfter from "./BeforeAfter";
import DraftCard, {
  BUCKET,
  BUCKET_ORDER,
  CHECK,
  CHEVRON,
  ConditionMark,
  Icon,
  bucketOf,
  draftHasCondition,
  excerpt,
  opensByDefault,
  sourceOf,
  tidy,
  valueText,
  verdictLabel,
} from "./DraftCard";
import IdeaForm from "./IdeaForm";

const BLIND_SPOT =
  "Rationale in non-public sources (preclinical toxicology, internal development data, regulator correspondence) cannot be seen by ProtocolOS.";
const EL3_NCT = "NCT03409614";
const TIMEOUT_MS = 150_000;

// One draft request: what to fetch, where its result and its failure are shown, and how it sets the URL.
interface Job {
  label: string;
  cold: boolean;
  fetcher: (signal: AbortSignal) => Promise<Draft>;
  presetId: string | null;
  query: (d: Draft) => string;
  scroll: boolean;
  // A failed idea is reported next to its submit button; a preset or a link, above the results.
  where: "idea" | "results";
  // Only the run a URL started keeps the URL's #draft-<id>; a later choice starts at the top of its draft.
  keepHash?: boolean;
}
interface Failure {
  message: string;
  transient: boolean;
  where: "idea" | "results";
  job: Job | null;
  key?: boolean; // the visitor can fix it by entering (another) model key
}
type Run =
  | { state: "idle" }
  | { state: "loading"; cold: boolean; label: string; presetId: string | null }
  | { state: "failed"; failure: Failure }
  | { state: "done" };

// The selection lives in the URL (?preset= or ?d=); navigation keeps the current pathname, nothing hardcodes "/".
function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}
function setQuery(query: string, keepHash: boolean) {
  window.history.replaceState(null, "", `${window.location.pathname}${query}${keepHash ? window.location.hash : ""}`);
}

// Like the contracts' request(), with an AbortSignal: a timed-out or superseded run stops its request instead of
// leaving it open, so a retry does not queue behind it in the browser.
async function fetchDraft(path: string, signal: AbortSignal, init?: RequestInit, withKey = false): Promise<Draft> {
  const headers = { "content-type": "application/json", "X-ProtocolOS-Session": sessionId(), ...(withKey ? keyHeaders() : {}) };
  const res = await fetch(path, { ...init, signal, headers });
  if (!res.ok) {
    let detail: string | null = null;
    let code: string | null = null;
    try {
      const body = (await res.json()) as { detail?: unknown; code?: unknown };
      detail = typeof body.detail === "string" ? body.detail : null;
      code = typeof body.code === "string" ? body.code : null;
    } catch {
      detail = null;
    }
    throw new ApiError(`${init?.method ?? "GET"} ${path} returned ${res.status}`, res.status, detail, code);
  }
  return (await res.json()) as Draft;
}
const getDraftOnce = (id: string, signal: AbortSignal) => fetchDraft(`/api/draft/${encodeURIComponent(id)}`, signal);
// A new idea is drafted on the server only with the visitor's own key (trialforge/access.py); examples need none.
const postDraftOnce = (idea: Idea, signal: AbortSignal, withKey = false) =>
  fetchDraft("/api/draft", signal, { method: "POST", body: JSON.stringify(idea) }, withKey);
const KEY_CODES = new Set(["key_required", "key_invalid", "key_malformed", "model_unavailable"]);

// The page's own sentence for every failure; engine detail only where it helps the user fix the input.
function describe(err: unknown, timedOut: boolean): { message: string; transient: boolean; key?: boolean } {
  if (timedOut) {
    return { message: "No answer after 150 seconds. The engine may still be drafting it; try again in a minute, or open an example.", transient: true };
  }
  if (err instanceof ApiError && err.code && KEY_CODES.has(err.code)) {
    return {
      message: err.code === "key_required" ? "Drafting a new idea runs on the demo server, so it needs your own OpenAI or Anthropic key. The examples open without one." : (err.detail ?? "The key was not accepted."),
      transient: false,
      key: true,
    };
  }
  if (err instanceof ApiError && err.code && err.detail) return { message: err.detail, transient: err.code === "provider_unreachable" };
  if (err instanceof ApiError) {
    if (err.status === 422) {
      return {
        message: `The idea was not accepted${err.detail ? ` (${err.detail})` : ""}. Check the condition (3-120 characters) and 1-8 drugs of 2-40 characters each.`,
        transient: false,
      };
    }
    if (err.status === 429) return { message: "The public demo has reached its limit of new ideas. The examples still open.", transient: false };
    if (err.status === 503) {
      return { message: "ClinicalTrials.gov could not be reached, so no precedents were searched. Try again in a minute, or open an example.", transient: true };
    }
    if (err.status === 400 || err.status === 404) {
      return { message: "This draft is no longer cached on the engine, or the link is incomplete. Open an example, or describe the idea again.", transient: false };
    }
    return { message: `The engine could not finish this draft (error ${err.status}). Try again, or open an example.`, transient: true };
  }
  return { message: "The engine did not answer (network error). Check the connection, then try again or open an example.", transient: true };
}

const BUTTON =
  "inline-flex min-h-8 items-center gap-1.5 rounded-md border border-uncounted bg-white px-2.5 py-1 text-sm font-medium text-ink hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

function FailureNote({ failure, onRetry, onExample }: { failure: Failure; onRetry: (() => void) | null; onExample: (() => void) | null }) {
  if (failure.key)
    return (
      <div data-testid="draft-key" className="flex flex-col gap-2">
        <p className="text-sm text-ink">{failure.message}</p>
        <ModelKeyForm
          autoFocus
          purpose="Drafting itself uses no model tokens; the key keeps the shared demo server open to everyone, and the same key answers the review's Ask tab."
          onReady={() => onRetry?.()}
        />
      </div>
    );
  return (
    <div data-testid="draft-error" role="alert" className="flex flex-col gap-2 rounded-lg border border-verdict/40 bg-white p-3 text-sm">
      <p className="break-words text-verdict [overflow-wrap:anywhere]">{failure.message}</p>
      {(failure.transient && onRetry) || onExample ? (
        <div className="flex flex-wrap gap-2">
          {failure.transient && onRetry ? (
            <button type="button" data-testid="draft-retry" onClick={onRetry} className={BUTTON}>
              Try again
            </button>
          ) : null}
          {onExample ? (
            <button type="button" data-testid="draft-open-example" onClick={onExample} className={BUTTON}>
              Open an example
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function groupsOf(criteria: DraftCriterion[]) {
  return BUCKET_ORDER.map((bucket) => ({ bucket, items: criteria.filter((c) => bucketOf(c) === bucket) })).filter((g) => g.items.length > 0);
}

function shownValue(c: DraftCriterion): string {
  return c.proposed ? valueText(c.proposed.operator, c.proposed.value, c.proposed.unit, c.label) : "no value";
}

function IdeaLine({ draft }: { draft: Draft }) {
  const i = draft.idea;
  return (
    <p className="text-[13px] text-muted">
      {i.condition} · {i.recognized_drugs.join(", ") || "no recognized drugs"}
      {i.classes.length ? ` (${i.classes.join(", ")})` : ""}
      {i.setting.length ? ` · ${i.setting.join(", ")}` : ""} · {i.phase === "PHASE2" ? "Phase 2" : "Phase 3"}
      {i.as_of ? ` · precedents started before ${i.as_of}` : ""}
      {i.unrecognized_drugs.length ? <span className="font-medium text-ink"> · not in the curated drug table: {i.unrecognized_drugs.join(", ")}</span> : null}
    </p>
  );
}

function Summary({ draft }: { draft: Draft }) {
  const s = draft.summary;
  return (
    <div data-testid="draft-summary" data-draft-id={draft.draft_id} data-cached={s.cached} role="status" className="flex min-w-0 flex-1 basis-[34rem] flex-col gap-1">
      <p className="text-lg leading-snug text-ink">
        <span className="font-semibold">
          {s.drafted} criteri{s.drafted === 1 ? "on" : "a"} drafted
        </span>{" "}
        from {s.precedents} regimen-matched precedent{s.precedents === 1 ? "" : "s"}
        {s.insufficient ? (
          <>
            {" · "}
            <span className="font-semibold">{s.insufficient} with no value proposed</span>
          </>
        ) : null}
      </p>
      <IdeaLine draft={draft} />
      <p className="text-xs text-muted">
        {s.candidates_checked} candidate trials checked{s.skipped ? `, ${s.skipped} skipped` : ""}
        {s.cached ? "" : ` · computed in ${s.elapsed_s.toFixed(1)} s`}
      </p>
    </div>
  );
}

// The verdict band: one tile per self-critique verdict, with its count, a link to its group of cards, and every
// criterion in it. Chip, band and group heading share one label function.
function VerdictBand({ draft, onOpen }: { draft: Draft; onOpen: (id: string) => void }) {
  const groups = groupsOf(draft.criteria);
  if (!groups.length) return null;
  return (
    <nav data-testid="draft-index" aria-label="Criteria by self-critique verdict">
      <ul data-testid="draft-verdict-counts" className="grid grid-cols-1 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(12.5rem,1fr))]">
        {groups.map(({ bucket, items }) => {
          const b = BUCKET[bucket];
          return (
            <li key={bucket} data-bucket={bucket} data-count={items.length} className={`flex flex-col gap-2 rounded-lg px-3 py-2.5 ${b.chip}`}>
              <a href={`#group-${bucket}`} className="flex items-center gap-2.5 self-start rounded text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink">
                <span className="text-3xl font-semibold leading-none tabular-nums tracking-tight">{items.length}</span>
                <span className="inline-flex items-start gap-1 text-sm font-medium leading-tight">
                  <Icon d={b.icon} className={`mt-px ${b.tone}`} />
                  {b.label}
                </span>
              </a>
              <ul className="flex flex-col gap-1 text-[13px] leading-snug">
                {items.map((c) => (
                  <li key={c.id}>
                    <a
                      href={`#draft-${c.id}`}
                      onClick={() => onOpen(c.id)}
                      className="text-ink underline decoration-ink/25 underline-offset-2 hover:decoration-ink"
                    >
                      {c.label}
                    </a>{" "}
                    <span className="whitespace-nowrap tabular-nums text-muted">{shownValue(c)}</span>
                    {draftHasCondition(c) ? (
                      <>
                        {" "}
                        <ConditionMark short />
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const STEPS = [
  ["Match precedents", "earlier trials that share the regimen's drug classes (setting excludes perioperative and other-histology trials)"],
  ["Draft from their protocols", "a value only where the verifier matched it to a protocol page"],
  ["Critique each value", "with the same review that checks finished protocols"],
] as const;

// The three steps of a draft; during a cold run the current one is marked (estimated from the elapsed time).
function Steps({ active = null }: { active?: number | null }) {
  return (
    <ol aria-label="How a draft is made" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted sm:grid sm:grid-cols-3 sm:gap-x-5">
      {STEPS.map(([title, detail], i) => {
        const state = active === null ? "idle" : i < active ? "done" : i === active ? "active" : "todo";
        return (
          <li key={title} data-state={state} aria-current={state === "active" ? "step" : undefined} className="flex gap-1.5">
            <span
              aria-hidden="true"
              className={`mt-px inline-grid h-4 w-4 shrink-0 place-items-center rounded-full text-[10px] font-medium ${
                state === "todo" ? "border border-uncounted text-muted" : state === "done" ? "bg-support text-paper" : "bg-ink text-paper"
              } ${state === "active" ? "ring-2 ring-ink/20 ring-offset-1 ring-offset-paper" : ""}`}
            >
              {state === "done" ? <Icon d={CHECK} className="h-2.5 w-2.5" /> : i + 1}
            </span>
            <span>
              <span className={`font-medium ${state === "todo" ? "text-muted" : "text-ink"}`}>{title}</span>
              <span className="hidden sm:inline">: {detail}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ColdProgress() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const stage = elapsed < 10 ? 0 : elapsed < 60 ? 1 : 2;
  return (
    <div className="flex flex-col gap-3">
      <Steps active={stage} />
      <div data-testid="draft-progress" className="flex items-center gap-3 rounded-lg border border-line bg-white p-4 text-sm text-ink">
        <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-ink motion-reduce:animate-none" aria-hidden="true" />
        <span role="status" className="flex-1">
          Searching ClinicalTrials.gov and reading protocols (up to 2.5 minutes)
        </span>
        <span aria-hidden="true" className="tabular-nums text-muted">
          {elapsed} s
        </span>
      </div>
      <p className="text-xs text-muted">The marked step is estimated from the elapsed time.</p>
    </div>
  );
}

// No value can be proposed at all: one sentence, the next step, and no download.
function EmptyResult({ draft, vocabulary }: { draft: Draft; vocabulary: DraftVocabulary | null }) {
  const s = draft.summary;
  // One example name per drug class, so the hint shows the range of the table rather than six PD-1 inhibitors.
  const known = vocabulary
    ? vocabulary.drugs.filter((d, i, all) => all.findIndex((x) => x.drug_class === d.drug_class) === i).map((d) => d.name).slice(0, 6)
    : ["pembrolizumab", "carboplatin", "pemetrexed", "paclitaxel"];
  const [lead, next] =
    draft.status === "unrecognized_regimen"
      ? [
          `None of the drugs (${draft.idea.unrecognized_drugs.join(", ") || draft.idea.drugs.join(", ")}) is in the curated drug table, so precedents cannot be matched by drug class.`,
          `Use names from the table, for example ${known.join(", ")}, or open an example.`,
        ]
      : draft.status === "retrieval_failed"
        ? ["ClinicalTrials.gov could not be reached for this idea, so no precedents were searched.", "Try again in a minute, or open an example."]
        : [
            `No regimen-matched precedent was found (${s.candidates_checked} candidate trial${s.candidates_checked === 1 ? "" : "s"} checked), so no value can be proposed.`,
            "Try the condition in English, fewer setting tags, or the other phase.",
          ];
  return (
    <div data-testid="draft-result" data-status={draft.status} className="flex flex-col gap-3">
      <div data-testid="draft-summary" data-draft-id={draft.draft_id} data-cached={s.cached} role="status" className="flex flex-col gap-1.5 rounded-lg bg-look-soft px-4 py-3">
        <p className="text-base font-semibold text-ink">{lead}</p>
        <p className="text-sm text-ink">{next}</p>
        <IdeaLine draft={draft} />
      </div>
      {draft.status !== "unrecognized_regimen" && draft.warnings.length ? (
        <ul className="text-[13px] text-muted">
          {draft.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// The draft as a protocol author can paste it: per criterion the value or the gap, the precedent's own words with
// its page, the self-critique as /draft labels it, and the next step.
function draftMarkdown(draft: Draft): string {
  const i = draft.idea;
  const out: string[] = [`# Draft eligibility criteria: ${i.condition}`, ""];
  out.push(`- Regimen: ${i.recognized_drugs.join(", ") || i.drugs.join(", ")}${i.classes.length ? ` (${i.classes.join(", ")})` : ""}`);
  if (i.setting.length) out.push(`- Setting: ${i.setting.join(", ")}`);
  out.push(`- Phase: ${i.phase === "PHASE2" ? "2" : "3"}`);
  if (i.as_of) out.push(`- Precedents: trials that started before ${i.as_of}`);
  out.push(`- Drafted by ProtocolOS from ${draft.summary.precedents} regimen-matched precedent${draft.summary.precedents === 1 ? "" : "s"} on ${draft.computed_at.slice(0, 10)} (draft ${draft.draft_id})`);
  out.push("", "Each value is copied from a regimen-matched precedent and matched to that protocol page. These are suggestions with a traceable rationale; the team decides. A difference from precedent is a review question.", "");
  for (const section of ["inclusion", "exclusion"] as const) {
    const items = draft.criteria.filter((c) => c.section === section);
    if (!items.length) continue;
    out.push(`## ${section === "inclusion" ? "Inclusion" : "Exclusion"} criteria`, "");
    items.forEach((c, n) => {
      out.push(`### ${n + 1}. ${c.label}`, "");
      const src = sourceOf(c);
      if (c.status === "drafted" && c.proposed) {
        out.push(`- Value: ${valueText(c.proposed.operator, c.proposed.value, c.proposed.unit, c.label)}${draftHasCondition(c) ? " (the source wording adds a condition; see the quote)" : ""}`);
        const where = src ? `${src.acronym ?? src.nct_id}${src.page ? `, protocol p.${src.page}` : ""}` : c.proposed.source_nct_id;
        out.push(`- Source: ${where}${src ? `: "${excerpt(src.quote)}"` : ""}`);
        if (src?.url) out.push(`- Protocol: ${src.page ? `${src.url}#page=${src.page}` : src.url}`);
        if (c.verification) out.push(`- Verifier: ${c.verification.status.toLowerCase().replaceAll("_", " ")} (${c.verification.checks.length} checks)`);
      } else {
        out.push(`- Value: Insufficient evidence, no value proposed.${c.insufficient_reason ? ` ${c.insufficient_reason}` : ""}`);
      }
      out.push(`- Self-critique: ${verdictLabel(c)}`);
      const next = tidy(c.critique.suggested_action.text);
      if (next) out.push(`- Next step: ${next}`);
      out.push("");
    });
  }
  out.push("---", "", `${BLIND_SPOT} Public data only. ProtocolOS prepares the rationale; the team decides.`, "");
  return out.join("\n");
}

const cardIdFromHash = () => (typeof window === "undefined" ? "" : decodeURIComponent(window.location.hash.replace(/^#draft-/, "")));

function Result({ draft, presetId, presetTitle }: { draft: Draft; presetId: string | null; presetTitle: string | null }) {
  // The exact response, re-serialized; a data: URL needs no cleanup.
  const json = useMemo(() => `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(draft, null, 2))}`, [draft]);
  const markdown = useMemo(() => `data:text/markdown;charset=utf-8,${encodeURIComponent(draftMarkdown(draft))}`, [draft]);
  const precedents = useMemo(() => new Map(draft.precedents.map((p) => [p.nct_id, p])), [draft]);
  const groups = groupsOf(draft.criteria);
  // The blind-spot sentence is in the page footer; the notes keep everything else.
  const notes = draft.notes.map((n) => n.replace(BLIND_SPOT, "").trim()).filter((n) => n.length > 0);

  // Review recommended and drafted-but-insufficient cards start open, plus one named in the URL hash.
  const [open, setOpen] = useState<Set<string>>(() => {
    const ids = new Set(draft.criteria.filter(opensByDefault).map((c) => c.id));
    const fromHash = cardIdFromHash();
    if (fromHash && draft.criteria.some((c) => c.id === fromHash)) ids.add(fromHash);
    return ids;
  });
  const openOne = useCallback((id: string) => setOpen((prev) => (prev.has(id) ? prev : new Set(prev).add(id))), []);
  const toggle = useCallback(
    (id: string) =>
      setOpen((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  useEffect(() => {
    const onHash = () => {
      const id = cardIdFromHash();
      if (id) openOne(id);
    };
    window.addEventListener("hashchange", onHash);
    // A link that names a card (…#draft-ecog) lands on it once the draft is drawn.
    const id = cardIdFromHash();
    const target = id ? document.getElementById(`draft-${id}`) : null;
    if (target) requestAnimationFrame(() => target.scrollIntoView({ block: "start" }));
    return () => window.removeEventListener("hashchange", onHash);
  }, [openOne]);

  if (draft.status !== "ok") return null;

  return (
    <div data-testid="draft-result" data-status={draft.status} className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <Summary draft={draft} />
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1">
            <a data-testid="draft-download-md" href={markdown} download={`${draft.draft_id}.md`} className={BUTTON}>
              <Icon d="M8 2v8M4.5 7L8 10.5 11.5 7M3 13h10" />
              Download criteria (Markdown)
            </a>
            <a
              data-testid="draft-download"
              href={json}
              download={`${draft.draft_id}.json`}
              className="-mx-1 inline-block rounded px-1 py-1 text-[13px] text-muted underline decoration-line underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-ink"
            >
              Download JSON
            </a>
          </div>
        </div>
        {draft.warnings.length ? (
          <ul className="rounded-md bg-look-soft px-3 py-2 text-sm text-ink">
            {draft.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        ) : null}
        <VerdictBand draft={draft} onOpen={openOne} />
      </div>

      {presetId === "el3-design-time" ? <BeforeAfter draft={draft} nct={EL3_NCT} presetTitle={presetTitle} onOpen={openOne} /> : null}

      {draft.precedents.length ? (
        <details className="rounded-lg border border-line bg-white px-3 py-2 text-sm">
          <summary className="min-h-6 cursor-pointer select-none rounded py-0.5 font-medium text-ink focus-visible:outline-2 focus-visible:outline-ink">
            {draft.precedents.length} regimen-matched precedent{draft.precedents.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {draft.precedents.map((p) => (
              <li key={p.nct_id} className="flex flex-wrap gap-x-2 text-[13px]">
                {p.protocol_url ? (
                  <a href={p.protocol_url} target="_blank" rel="noreferrer" className="font-medium text-ink underline decoration-line underline-offset-2">
                    {p.acronym ?? p.nct_id}
                  </a>
                ) : (
                  <span className="font-medium text-ink">{p.acronym ?? p.nct_id}</span>
                )}
                <span className="text-muted">{p.title}</span>
                <span className="text-muted">
                  {p.start_date ?? "start unknown"} · shares {p.shared_classes.join(", ") || "no class"}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {groups.map(({ bucket, items }) => (
        <section key={bucket} aria-labelledby={`group-${bucket}`} className="flex flex-col gap-2.5">
          <h2 id={`group-${bucket}`} className="flex scroll-mt-4 items-center gap-1.5 text-sm font-semibold text-ink">
            <Icon d={BUCKET[bucket].icon} className={BUCKET[bucket].tone} />
            {BUCKET[bucket].label}
            <span className="font-normal tabular-nums text-muted">{items.length}</span>
          </h2>
          {items.map((c) => (
            <DraftCard key={c.id} c={c} precedents={precedents} open={open.has(c.id)} onToggle={() => toggle(c.id)} />
          ))}
        </section>
      ))}

      {draft.exports.trialpathfinder_rules ? (
        <details data-testid="draft-trialpathfinder" className="rounded-lg border border-line bg-white px-3 py-2 text-sm">
          <summary className="min-h-6 cursor-pointer select-none rounded py-0.5 font-medium text-ink focus-visible:outline-2 focus-visible:outline-ink">
            Plain-text criteria list (TrialPathfinder-style; not loadable as is)
          </summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-[13px] text-ink">{draft.exports.trialpathfinder_rules}</pre>
        </details>
      ) : null}

      <section data-testid="draft-notes" className="flex flex-col gap-1 border-t border-line pt-3 text-[13px] text-muted">
        {notes.map((n, i) => (
          <p key={i}>{n}</p>
        ))}
      </section>
    </div>
  );
}

export default function DraftPage() {
  const search = useSyncExternalStore(subscribe, () => window.location.search, () => "");
  const [presets, setPresets] = useState<DraftPreset[] | null>(null);
  const [presetsFailed, setPresetsFailed] = useState(false);
  const [vocabulary, setVocabulary] = useState<DraftVocabulary | null>(null);
  const [vocabularyFailed, setVocabularyFailed] = useState(false);
  const [run, setRun] = useState<Run>({ state: "idle" });
  // The last draft that loaded; it stays on screen when a later run fails.
  const [shown, setShown] = useState<{ draft: Draft; presetId: string | null } | null>(null);
  // Below lg the idea form folds away under the examples, so the loaded draft is on the first screen.
  const [ideaOpen, setIdeaOpen] = useState(false);
  const ticket = useRef(0);
  const inflight = useRef<AbortController | null>(null);
  const started = useRef(false);
  const results = useRef<HTMLElement>(null);

  useEffect(() => {
    getDraftPresets().then(setPresets, () => setPresetsFailed(true));
    getDraftVocabulary().then(setVocabulary, () => setVocabularyFailed(true));
  }, []);

  const narrow = () => window.matchMedia("(max-width: 1023px)").matches;
  const behavior = (): ScrollBehavior => (window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

  // Below the two-column breakpoint the results sit under the form, so a run the user asked for scrolls them into view.
  const reveal = useCallback(() => {
    if (!narrow()) return;
    results.current?.scrollIntoView({ block: "start", behavior: behavior() });
  }, []);

  const go = useCallback(
    (job: Job) => {
      // Any run settles the URL, so the deep-link effect below only ever handles the query present at first load.
      started.current = true;
      const mine = ++ticket.current;
      inflight.current?.abort();
      const ctrl = new AbortController();
      inflight.current = ctrl;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, TIMEOUT_MS);
      setRun({ state: "loading", cold: job.cold, label: job.label, presetId: job.presetId });
      if (job.scroll) reveal();
      job.fetcher(ctrl.signal).then(
        (draft) => {
          clearTimeout(timer);
          if (mine !== ticket.current) return;
          setQuery(job.query(draft), job.keepHash === true);
          setShown({ draft, presetId: job.presetId });
          setRun({ state: "done" });
          if (job.scroll) requestAnimationFrame(reveal);
        },
        (err: unknown) => {
          clearTimeout(timer);
          if (mine !== ticket.current) return;
          setRun({ state: "failed", failure: { ...describe(err, timedOut), where: job.where, job } });
          requestAnimationFrame(() => {
            if (job.where === "results") {
              if (job.scroll) reveal();
            } else {
              // Next to the submit button; on a short desktop screen that is inside the scrolling sidebar.
              document.querySelector('[data-testid="draft-error"]')?.scrollIntoView({ block: narrow() ? "center" : "nearest", behavior: behavior() });
            }
          });
        },
      );
    },
    [reveal],
  );

  const openPreset = useCallback(
    (p: DraftPreset, scroll = true, keepHash = false) =>
      go({
        label: p.title,
        cold: !p.cached,
        fetcher: (signal) =>
          getDraftOnce(p.draft_id, signal).catch((e: unknown) => (e instanceof ApiError && e.status === 404 ? postDraftOnce(p.idea, signal) : Promise.reject(e))),
        presetId: p.id,
        query: () => `?preset=${encodeURIComponent(p.id)}`,
        scroll,
        where: "results",
        keepHash,
      }),
    [go],
  );

  const submitIdea = useCallback(
    (idea: Idea) =>
      go({
        label: idea.condition,
        cold: true,
        fetcher: (signal) => postDraftOnce(idea, signal, true),
        presetId: null,
        query: (d) => `?d=${encodeURIComponent(d.draft_id)}`,
        scroll: true,
        where: "idea",
      }),
    [go],
  );

  // Deep links: ?preset=<id> waits for the preset list; ?d=<draft_id> loads the cached draft directly. With neither,
  // the first preset opens (a cached real draft, about 0.1 s), so the page never starts as an empty canvas.
  useEffect(() => {
    if (started.current) return;
    const params = new URLSearchParams(search);
    const d = params.get("d");
    const preset = params.get("preset");
    // Started from a microtask so the effect itself does not set state synchronously.
    if (d) {
      started.current = true;
      queueMicrotask(() =>
        go({
          label: "saved draft",
          cold: false,
          fetcher: (signal) => getDraftOnce(d, signal),
          presetId: null,
          query: () => `?d=${encodeURIComponent(d)}`,
          scroll: true,
          where: "results",
          keepHash: true,
        }),
      );
    } else if (preset && presets) {
      started.current = true;
      const p = presets.find((x) => x.id === preset);
      queueMicrotask(() =>
        p
          ? openPreset(p, true, true)
          : setRun({ state: "failed", failure: { message: `There is no example called "${preset}". Open one of the examples.`, transient: false, where: "results", job: null } }),
      );
    } else if (!preset && presets?.length) {
      started.current = true;
      const first = presets[0];
      queueMicrotask(() => openPreset(first, false, true));
    }
  }, [search, presets, go, openPreset]);

  const keySet = useModelKey() !== null;
  const loading = run.state === "loading";
  const failure = run.state === "failed" ? run.failure : null;
  const activePreset = run.state === "loading" ? run.presetId : (shown?.presetId ?? null);
  const shownTitle = shown?.presetId ? (presets?.find((p) => p.id === shown.presetId)?.title ?? null) : null;
  const firstPreset = presets?.[0] ?? null;
  const onExample = firstPreset ? () => openPreset(firstPreset) : null;
  const failedJob = failure?.job ?? null;
  const onRetry = failedJob ? () => go(failedJob) : null;
  const ideaCollapsed = !ideaOpen && !presetsFailed;

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#draft-results"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-ink focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-paper focus:outline-2 focus:outline-offset-2 focus:outline-ink"
      >
        Skip to draft
      </a>
      <AppHeader mode="draft" />
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-start lg:gap-6 lg:py-6">
        {/* The sidebar scrolls on its own when it is taller than the screen, so the form's end stays reachable while sticky. */}
        <aside className="flex w-full flex-col gap-4 lg:sticky lg:top-4 lg:-m-1.5 lg:max-h-[calc(100dvh-2rem)] lg:w-[20.75rem] lg:shrink-0 lg:overflow-y-auto lg:p-1.5">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-ink">Create criteria from an idea</h1>
            <p className="mt-1 text-sm text-muted">
              Lab, ECOG and washout criteria drafted from earlier trials of a similar regimen; each proposed value is verified against its source, then
              critiqued.
            </p>
          </div>

          <section className="flex flex-col gap-1.5" aria-labelledby="presets-title">
            <h2 id="presets-title" className="text-xs font-medium uppercase tracking-wide text-muted">
              Start from an example
            </h2>
            {presetsFailed ? <p className="text-sm text-verdict">Could not load the examples.</p> : null}
            {presets === null && !presetsFailed ? <p className="text-sm text-muted">Loading examples…</p> : null}
            {presets?.map((p) => (
              <button
                key={p.id}
                type="button"
                data-testid={`preset-${p.id}`}
                aria-pressed={activePreset === p.id}
                onClick={() => openPreset(p)}
                className={`flex flex-col items-start rounded-md border px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink ${
                  activePreset === p.id ? "border-ink bg-white" : "border-line bg-white hover:border-muted"
                }`}
              >
                <span className="font-medium text-ink">{p.title}</span>
                <span className="text-xs text-muted">
                  {p.idea.drugs.join(", ")}
                  {p.idea.as_of ? ` · precedents before ${p.idea.as_of}` : ""}
                </span>
              </button>
            ))}
          </section>

          <section className="flex flex-col gap-1.5 rounded-lg border border-line bg-white p-3" aria-labelledby="idea-title">
            <h2 id="idea-title" className="text-xs font-medium uppercase tracking-wide text-muted">
              <button
                type="button"
                data-testid="idea-toggle"
                aria-expanded={!ideaCollapsed}
                aria-controls="idea-body"
                onClick={() => setIdeaOpen(ideaCollapsed)}
                className="flex min-h-8 w-full items-center justify-between rounded text-left uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink lg:hidden"
              >
                Or describe your own idea
                <Icon d={CHEVRON} className={`h-4 w-4 transition-transform duration-150 ${ideaCollapsed ? "" : "rotate-180"}`} />
              </button>
              <span className="hidden lg:inline">Or describe your own</span>
            </h2>
            <div id="idea-body" className={ideaCollapsed ? "hidden lg:block" : ""}>
              <IdeaForm
                vocabulary={vocabulary}
                vocabularyFailed={vocabularyFailed}
                busy={loading}
                onSubmit={submitIdea}
                error={failure?.where === "idea" && !failure.key ? <FailureNote failure={failure} onRetry={onRetry} onExample={onExample} /> : null}
                readyHint={keySet ? null : "A new idea needs your own OpenAI or Anthropic key; you are asked for it next."}
              />
              {/* The key form is a form of its own, so it sits after the idea form, not inside it. */}
              {failure?.where === "idea" && failure.key ? (
                <div className="mt-3">
                  <FailureNote failure={failure} onRetry={onRetry} onExample={onExample} />
                </div>
              ) : null}
            </div>
          </section>
        </aside>

        <section ref={results} id="draft-results" tabIndex={-1} aria-label="Draft" className="flex min-w-0 flex-1 scroll-mt-4 flex-col gap-4 focus:outline-none">
          {loading && run.cold ? <ColdProgress /> : <Steps />}

          {loading && !run.cold ? (
            <div data-testid="draft-progress" role="status" className="flex items-center gap-3 rounded-lg border border-line bg-white p-4 text-sm text-ink">
              <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-ink motion-reduce:animate-none" aria-hidden="true" />
              <span>Loading {run.label}…</span>
            </div>
          ) : null}

          {failure?.where === "results" ? <FailureNote failure={failure} onRetry={onRetry} onExample={onExample} /> : null}

          {!loading && shown ? (
            shown.draft.status === "ok" ? (
              <Result key={shown.draft.draft_id} draft={shown.draft} presetId={shown.presetId} presetTitle={shownTitle} />
            ) : (
              <EmptyResult draft={shown.draft} vocabulary={vocabulary} />
            )
          ) : null}

          <footer data-testid="blind-spot" className="mt-auto border-t border-line pt-3 text-[13px] text-muted">
            <p>{BLIND_SPOT}</p>
            <p className="mt-1">Public data only. ProtocolOS prepares the rationale; the team decides.</p>
          </footer>
        </section>
      </main>
    </div>
  );
}
