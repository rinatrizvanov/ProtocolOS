"use client";

import { useEffect, useSyncExternalStore } from "react";
import { CACHED_TRIALS, NCT, getReview, type Classification, type Selection } from "@/lib/api";
import { DISPLAY_CLASSIFICATION } from "@/lib/contracts";
import { useApi } from "@/lib/useApi";
import { AppHeader } from "../components/AppHeader";
import { Failed, Pending } from "../components/Frame";
import { ChatIcon, CheckCircleIcon, CompareIcon, GavelIcon, InfoIcon } from "../components/Icons";
import { MissingCriteria } from "../components/MissingCriteria";
import { RationalePanel } from "../components/RationalePanel";
import ChallengeExamples from "../screens/ChallengeExamples";
import Screen2 from "../screens/Screen2";
import Screen4 from "../screens/Screen4";
import Screen7 from "../screens/Screen7";

const TABS = [
  { id: "rationale", title: "Rationale", Icon: InfoIcon, render: (s: Selection) => <RationalePanel {...s} /> },
  { id: "compare", title: "Compare", Icon: CompareIcon, render: (s: Selection) => <Screen2 {...s} detailed /> },
  { id: "ask", title: "Ask", Icon: ChatIcon, render: (s: Selection) => <Screen4 {...s} /> },
  { id: "verify", title: "Verify", Icon: CheckCircleIcon, render: (s: Selection) => <ChallengeExamples {...s} /> },
  { id: "decide", title: "Decide", Icon: GavelIcon, render: (s: Selection) => <Screen7 {...s} detailed /> },
] as const;
type TabId = (typeof TABS)[number]["id"];

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

// The selection lives only in the URL (?nct=&c=&tab=), so a reload keeps it; only cached trials are accepted.
function subscribeToUrl(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

function navigate(next: { nct: string; criterionId: string | null; tab: TabId }) {
  const params = new URLSearchParams({ nct: next.nct });
  if (next.criterionId) params.set("c", next.criterionId);
  if (next.tab !== "rationale") params.set("tab", next.tab);
  // Keep the current path so the page works at /review, /review/ and under any mount point.
  window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function parseSelection(search: string): { nct: string; criterionId: string | null; tab: TabId } {
  const params = new URLSearchParams(search);
  const nct = params.get("nct") ?? NCT;
  const rawTab = params.get("tab");
  const tab = (TABS.find((t) => t.id === rawTab)?.id ?? "rationale") as TabId;
  return (CACHED_TRIALS as readonly string[]).includes(nct)
    ? { nct, criterionId: params.get("c"), tab }
    : { nct: NCT, criterionId: null, tab };
}

function CriteriaList({ nct, selected, tab }: { nct: string; selected: string | null; tab: TabId }) {
  const state = useApi(() => getReview(nct));
  const first = state.status === "ready" ? state.data.reviews[0]?.criterion.id : undefined;
  useEffect(() => {
    if (selected === null && first) navigate({ nct, criterionId: first, tab });
  }, [nct, selected, first, tab]);

  if (state.status === "loading") return <Pending label="Loading the criteria…" />;
  if (state.status === "error") return <Failed message={state.message} />;
  const study = state.data.target.study;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">
        <span className="font-medium text-ink">{study.acronym ?? study.nct_id}</span> · {state.data.reviews.length} criteria
      </p>
      <ul className="flex flex-col gap-0.5">
        {state.data.reviews.map((r) => (
          <li key={r.criterion.id}>
            <button
              type="button"
              data-testid="criterion-item"
              data-criterion={r.criterion.id}
              data-classification={r.classification}
              aria-current={r.criterion.id === selected ? "true" : undefined}
              onClick={() => navigate({ nct, criterionId: r.criterion.id, tab })}
              className={`w-full rounded-r-md border-l-4 px-3 py-1.5 text-left transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink ${TONE[r.classification]} ${
                r.criterion.id === selected ? "bg-line text-ink" : "text-muted hover:bg-line/50 hover:text-ink"
              }`}
            >
              <span className="block text-sm font-medium text-ink">{r.criterion.label}</span>
              <span className="flex items-center justify-between gap-2 text-xs">
                <span className="tabular-nums">
                  {r.criterion.operator} {r.criterion.value_norm} {r.criterion.unit_norm}
                </span>
                <span className="flex items-center gap-1">
                  <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${DOT[r.classification]}`} />
                  {DISPLAY_CLASSIFICATION[r.classification]}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ReviewPage() {
  const search = useSyncExternalStore(subscribeToUrl, () => window.location.search, () => null);
  if (search === null) return null;
  const { nct, criterionId, tab } = parseSelection(search);
  const active = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <>
      <AppHeader mode="review" />
      <main className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Finishing a trial</h1>
          <label className="flex items-center gap-2 text-sm text-muted">
            Trial
            <select
              data-testid="trial-picker"
              value={nct}
              onChange={(e) => navigate({ nct: e.target.value, criterionId: null, tab })}
              className="rounded-md border border-line bg-paper px-2 py-1 text-ink tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
            >
              {CACHED_TRIALS.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
          <nav aria-label="Criteria" className="flex flex-col gap-4">
            <CriteriaList key={nct} nct={nct} selected={criterionId} tab={tab} />
            <MissingCriteria nct={nct} />
          </nav>
          {criterionId ? (
            <section className="flex min-w-0 flex-col">
              <div role="tablist" aria-label="Views" className="flex gap-1 overflow-x-auto border-b border-line">
                {TABS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    aria-selected={t.id === active.id}
                    data-testid={`tab-${t.id}`}
                    onClick={() => navigate({ nct, criterionId, tab: t.id })}
                    className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink ${
                      t.id === active.id ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink"
                    }`}
                  >
                    <t.Icon />
                    {t.title}
                  </button>
                ))}
              </div>
              <div key={`${nct}:${criterionId}:${active.id}`} role="tabpanel" data-tab={active.id} className="flex flex-1 flex-col pt-4">
                {active.render({ nct, criterionId })}
              </div>
            </section>
          ) : null}
        </div>
      </main>
    </>
  );
}
