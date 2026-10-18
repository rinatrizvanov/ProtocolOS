"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ApiError,
  getDraft,
  getDraftPresets,
  getDraftVocabulary,
  postDraft,
  type Draft,
  type DraftPreset,
  type DraftVocabulary,
  type Idea,
} from "@/lib/contracts";
import { AppHeader } from "../components/AppHeader";
import BeforeAfter from "./BeforeAfter";
import DraftCard from "./DraftCard";
import IdeaForm from "./IdeaForm";

const BLIND_SPOT =
  "Rationale in non-public sources (preclinical toxicology, internal development data, regulator correspondence) cannot be seen by ProtocolOS.";
const EL3_NCT = "NCT03409614";
const TIMEOUT_MS = 150_000;

type Run =
  | { state: "idle" }
  | { state: "loading"; cold: boolean; label: string }
  | { state: "error"; message: string }
  | { state: "ready"; draft: Draft; presetId: string | null };

// The selection lives in the URL (?preset= or ?d=); navigation keeps the current pathname, nothing hardcodes "/".
function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}
function setQuery(query: string) {
  window.history.replaceState(null, "", `${window.location.pathname}${query}`);
}

function describe(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 422) return `The idea was not accepted (422)${err.detail ? `: ${err.detail}` : ". Check the condition (3-120 characters) and 1-8 drugs, each 2-40 characters."}`;
    if (err.status === 429) return err.detail ?? "New ideas limit reached on the public demo; presets still work.";
    if (err.status === 503) return err.detail ?? "ClinicalTrials.gov not reachable. Try again or use a preset.";
    // The engine's 400/404 detail is a route message (a draft_id pattern, "draft not cached"), not copy for users.
    if (err.status === 400 || err.status === 404) return "That draft is not cached or the link is malformed. Run the idea again.";
    return err.detail ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("No answer after 150 seconds. Try a preset, or try again later.")), TIMEOUT_MS);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function Svg({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

function Summary({ draft }: { draft: Draft }) {
  const s = draft.summary;
  return (
    <div data-testid="draft-summary" data-draft-id={draft.draft_id} data-cached={s.cached} className="flex flex-col gap-1">
      <p className="text-base text-ink">
        <span className="font-semibold">{s.drafted} drafted</span>
        <span className="text-muted"> · </span>
        <span className="font-semibold">{s.insufficient} insufficient evidence</span>
        <span className="text-muted">
          {" "}
          · from {s.precedents} regimen-matched precedent{s.precedents === 1 ? "" : "s"} ({s.candidates_checked} candidates checked
          {s.skipped ? `, ${s.skipped} skipped` : ""}) · {s.elapsed_s.toFixed(1)} s{s.cached ? ", cached" : ""}
        </span>
      </p>
      <p className="text-xs text-muted">
        {draft.idea.condition} · {draft.idea.recognized_drugs.join(", ") || "no recognized drugs"}
        {draft.idea.classes.length ? ` (${draft.idea.classes.join(", ")})` : ""}
        {draft.idea.setting.length ? ` · ${draft.idea.setting.join(", ")}` : ""} · {draft.idea.phase === "PHASE2" ? "Phase 2" : "Phase 3"}
        {draft.idea.as_of ? ` · precedents started before ${draft.idea.as_of}` : ""}
        {draft.idea.unrecognized_drugs.length ? (
          <span className="text-look"> · unrecognized: {draft.idea.unrecognized_drugs.join(", ")}</span>
        ) : null}
      </p>
    </div>
  );
}

const STATUS_COPY: Record<Exclude<Draft["status"], "ok">, string> = {
  no_precedents: "No regimen-matched precedent was found, so every criterion is Insufficient evidence.",
  unrecognized_regimen: "None of the drugs is in the vocabulary, so precedents cannot be matched by drug class.",
  retrieval_failed: "ClinicalTrials.gov could not be reached for this idea.",
};

function Result({ draft, presetId }: { draft: Draft; presetId: string | null }) {
  // The exact response, re-serialized; a data: URL needs no cleanup.
  const href = useMemo(() => `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(draft, null, 2))}`, [draft]);
  const drafted = draft.criteria.filter((c) => c.status === "drafted");
  const insufficient = draft.criteria.filter((c) => c.status !== "drafted");
  // The blind-spot sentence is in the page footer; the notes keep everything else.
  const notes = draft.notes.map((n) => n.replace(BLIND_SPOT, "").trim()).filter((n) => n.length > 0);

  return (
    <div data-testid="draft-result" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <Summary draft={draft} />
        <a
          data-testid="draft-download"
          href={href}
          download={`${draft.draft_id}.json`}
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-white px-2.5 py-1.5 text-sm text-ink hover:border-muted"
        >
          <Svg d="M8 2v8M4.5 7L8 10.5 11.5 7M3 13h10" />
          Download draft (JSON)
        </a>
      </div>

      {draft.status !== "ok" ? (
        <p role="status" className="rounded-md bg-look-soft px-3 py-2 text-sm text-ink">
          {STATUS_COPY[draft.status]}
        </p>
      ) : null}
      {draft.warnings.length ? (
        <ul className="rounded-md bg-look-soft px-3 py-2 text-sm text-ink">
          {draft.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}

      {draft.precedents.length ? (
        <details className="rounded-lg border border-line bg-white px-3 py-2 text-sm">
          <summary className="cursor-pointer select-none font-medium text-ink">
            {draft.precedents.length} regimen-matched precedent{draft.precedents.length === 1 ? "" : "s"}
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5">
            {draft.precedents.map((p) => (
              <li key={p.nct_id} className="flex flex-wrap gap-x-2 text-xs">
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

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {[...drafted, ...insufficient].map((c) => (
          <DraftCard key={c.id} c={c} />
        ))}
      </div>

      {presetId === "el3-design-time" ? <BeforeAfter draft={draft} nct={EL3_NCT} /> : null}

      {draft.exports.trialpathfinder_rules ? (
        <details data-testid="draft-trialpathfinder" className="rounded-lg border border-line bg-white px-3 py-2 text-sm">
          <summary className="cursor-pointer select-none font-medium text-ink">TrialPathfinder rules (text export)</summary>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs text-ink">{draft.exports.trialpathfinder_rules}</pre>
        </details>
      ) : null}

      <section data-testid="draft-notes" className="flex flex-col gap-1 border-t border-line pt-3 text-xs text-muted">
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
  const ticket = useRef(0);
  const started = useRef(false);

  useEffect(() => {
    getDraftPresets().then(setPresets, () => setPresetsFailed(true));
    getDraftVocabulary().then(setVocabulary, () => setVocabularyFailed(true));
  }, []);

  const go = useCallback((label: string, cold: boolean, fetcher: () => Promise<Draft>, presetId: string | null, query: (d: Draft) => string) => {
    // Any run settles the URL, so the deep-link effect below only ever handles the query present at first load.
    started.current = true;
    const mine = ++ticket.current;
    setRun({ state: "loading", cold, label });
    withTimeout(fetcher()).then(
      (draft) => {
        if (mine !== ticket.current) return;
        setQuery(query(draft));
        setRun({ state: "ready", draft, presetId });
      },
      (err: unknown) => {
        if (mine !== ticket.current) return;
        setRun({ state: "error", message: describe(err) });
      },
    );
  }, []);

  const openPreset = useCallback(
    (p: DraftPreset) =>
      go(
        p.title,
        !p.cached,
        () => getDraft(p.draft_id).catch((e: unknown) => (e instanceof ApiError && e.status === 404 ? postDraft(p.idea) : Promise.reject(e))),
        p.id,
        () => `?preset=${encodeURIComponent(p.id)}`,
      ),
    [go],
  );

  const submitIdea = useCallback(
    (idea: Idea) => go(idea.condition, true, () => postDraft(idea), null, (d) => `?d=${encodeURIComponent(d.draft_id)}`),
    [go],
  );

  // Deep links: ?preset=<id> waits for the preset list; ?d=<draft_id> loads the cached draft directly.
  useEffect(() => {
    if (started.current) return;
    const params = new URLSearchParams(search);
    const d = params.get("d");
    const preset = params.get("preset");
    // Started from a microtask so the effect itself does not set state synchronously.
    if (d) {
      started.current = true;
      queueMicrotask(() => go("saved draft", false, () => getDraft(d), null, () => `?d=${encodeURIComponent(d)}`));
    } else if (preset && presets) {
      started.current = true;
      const p = presets.find((x) => x.id === preset);
      queueMicrotask(() => (p ? openPreset(p) : setRun({ state: "error", message: `Unknown preset "${preset}".` })));
    }
  }, [search, presets, go, openPreset]);

  const activePreset = run.state === "ready" ? run.presetId : null;
  const busy = run.state === "loading";

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader mode="draft" />
      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 px-4 py-4 lg:flex-row lg:items-start lg:gap-6 lg:py-6">
        <aside className="flex w-full flex-col gap-4 lg:sticky lg:top-4 lg:w-80 lg:shrink-0">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink">Create criteria from an idea</h1>
            <p className="mt-1 text-sm text-muted">
              Lab, ECOG and washout criteria drafted from earlier trials of a similar regimen; each proposed value is verified against its source, then
              critiqued.
            </p>
          </div>

          <section className="flex flex-col gap-1.5" aria-label="Presets">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Start from an example</h2>
            {presetsFailed ? <p className="text-sm text-verdict">Could not load the examples.</p> : null}
            {presets === null && !presetsFailed ? <p className="text-sm text-muted">Loading examples…</p> : null}
            {presets?.map((p) => (
              <button
                key={p.id}
                type="button"
                data-testid={`preset-${p.id}`}
                disabled={busy}
                aria-pressed={activePreset === p.id}
                onClick={() => openPreset(p)}
                className={`flex flex-col items-start rounded-md border px-3 py-2 text-left text-sm disabled:opacity-60 ${
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

          <section className="flex flex-col gap-1.5 rounded-lg border border-line bg-white p-3" aria-label="Your idea">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Or describe your own</h2>
            <IdeaForm vocabulary={vocabulary} vocabularyFailed={vocabularyFailed} busy={busy} onSubmit={submitIdea} />
          </section>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col gap-4" aria-live="polite">
          {run.state === "idle" ? (
            <ol className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
              {[
                ["1", "Match precedents", "Earlier trials on ClinicalTrials.gov that share the regimen's drug classes and setting."],
                ["2", "Draft from their protocols", "A value only where the verifier matched the precedent's threshold to its protocol page."],
                ["3", "Critique each draft", "The same review that checks finished protocols classifies every drafted criterion."],
              ].map(([n, t, d]) => (
                <li key={n} className="rounded-lg border border-line bg-white p-3">
                  <p className="flex items-center gap-2 font-medium text-ink">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-ink text-xs text-paper">{n}</span>
                    {t}
                  </p>
                  <p className="mt-1 text-muted">{d}</p>
                </li>
              ))}
            </ol>
          ) : null}

          {run.state === "loading" ? (
            <div data-testid="draft-progress" role="status" className="flex items-center gap-3 rounded-lg border border-line bg-white p-4 text-sm text-ink">
              <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-line border-t-ink" aria-hidden="true" />
              <span>
                {run.cold ? "Searching ClinicalTrials.gov, reading protocols (up to 2 minutes)" : `Loading ${run.label}…`}
              </span>
            </div>
          ) : null}

          {run.state === "error" ? (
            <p data-testid="draft-error" role="alert" className="rounded-lg border border-verdict/40 bg-white p-4 text-sm text-verdict">
              {run.message}
            </p>
          ) : null}

          {run.state === "ready" ? <Result draft={run.draft} presetId={run.presetId} /> : null}

          <footer data-testid="blind-spot" className="mt-auto border-t border-line pt-3 text-xs text-muted">
            <p>{BLIND_SPOT}</p>
            <p className="mt-1">Public data only. ProtocolOS prepares the rationale; the team decides.</p>
          </footer>
        </section>
      </main>
    </div>
  );
}
