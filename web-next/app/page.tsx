"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { CACHED_TRIALS, NCT, getReview, type Classification, type Selection } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Failed, Pending } from "./components/Frame";
import ChallengeExamples from "./screens/ChallengeExamples";
import Screen2 from "./screens/Screen2";
import Screen3 from "./screens/Screen3";
import Screen4 from "./screens/Screen4";
import Screen7 from "./screens/Screen7";

// The verifier's demo arguments are about EL3's ANC and hemoglobin rules, so Challenge exists only for that trial.
const TABS = [
  { id: "compare", title: "Compare", render: (s: Selection) => <Screen2 {...s} /> },
  { id: "why", title: "Why", render: (s: Selection) => <Screen3 {...s} /> },
  { id: "ask", title: "Ask", render: (s: Selection) => <Screen4 {...s} /> },
  { id: "challenge", title: "Challenge", render: (s: Selection) => <ChallengeExamples {...s} />, onlyFor: NCT },
  { id: "decide", title: "Decide", render: (s: Selection) => <Screen7 {...s} /> },
];

const TONE: Record<Classification, string> = {
  "Review recommended": "border-look",
  "Evidence supports retaining": "border-support",
  "Insufficient evidence": "border-uncounted",
};

// The selection lives only in the URL (?nct=&c=), so a reload keeps it; only cached trials are accepted.
function subscribeToUrl(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

function navigate(nct: string, criterionId: string | null) {
  const query = criterionId ? `?nct=${nct}&c=${encodeURIComponent(criterionId)}` : `?nct=${nct}`;
  window.history.replaceState(null, "", `/${query}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function parseSelection(search: string): { nct: string; criterionId: string | null } {
  const params = new URLSearchParams(search);
  const nct = params.get("nct") ?? NCT;
  return (CACHED_TRIALS as readonly string[]).includes(nct)
    ? { nct, criterionId: params.get("c") }
    : { nct: NCT, criterionId: null };
}

function CriteriaList({ nct, selected }: { nct: string; selected: string | null }) {
  const state = useApi(() => getReview(nct));
  const first = state.status === "ready" ? state.data.reviews[0]?.criterion.id : undefined;
  useEffect(() => {
    if (selected === null && first) navigate(nct, first);
  }, [nct, selected, first]);

  if (state.status === "loading") return <Pending label="Loading the criteria…" />;
  if (state.status === "error") return <Failed message={state.message} />;
  return (
    <ul className="flex flex-col gap-1">
      {state.data.reviews.map((r) => (
        <li key={r.criterion.id}>
          <button
            type="button"
            data-testid="criterion-item"
            data-criterion={r.criterion.id}
            data-classification={r.classification}
            aria-current={r.criterion.id === selected ? "true" : undefined}
            onClick={() => navigate(nct, r.criterion.id)}
            className={`w-full border-l-4 px-3 py-2 text-left transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink ${TONE[r.classification]} ${
              r.criterion.id === selected ? "bg-line text-ink" : "text-muted hover:text-ink"
            }`}
          >
            <span className="block font-medium text-ink">{r.criterion.label}</span>
            <span className="block text-sm tabular-nums">
              {r.criterion.operator} {r.criterion.value_norm} {r.criterion.unit_norm}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function App() {
  const search = useSyncExternalStore(subscribeToUrl, () => window.location.search, () => null);
  const [tab, setTab] = useState("compare");

  if (search === null) return null;
  const { nct, criterionId } = parseSelection(search);
  const tabs = TABS.filter((t) => !t.onlyFor || t.onlyFor === nct);
  const active = tabs.find((t) => t.id === tab) ?? tabs[0];

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl flex-col px-8 py-6">
      <header className="flex items-center gap-6 border-b border-line pb-4">
        <span className="text-xl font-semibold text-ink">TrialLens</span>
        <label className="flex items-center gap-2 text-sm text-muted">
          Trial
          <select
            data-testid="trial-picker"
            value={nct}
            onChange={(e) => navigate(e.target.value, null)}
            className="rounded-md border border-line bg-paper px-2 py-1 text-ink tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
          >
            {CACHED_TRIALS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <Link
          href="/tour"
          data-testid="guided-demo"
          className="ml-auto rounded-md bg-ink px-4 py-2 text-sm text-paper hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          Guided demo
        </Link>
      </header>

      <div className="mt-6 grid flex-1 grid-cols-[18rem_1fr] gap-8">
        <nav aria-label="Criteria">
          <CriteriaList key={nct} nct={nct} selected={criterionId} />
        </nav>
        {criterionId ? (
          <section className="flex min-w-0 flex-col">
            <div role="tablist" aria-label="Views" className="flex gap-1 border-b border-line">
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={t.id === active.id}
                  data-testid={`tab-${t.id}`}
                  onClick={() => setTab(t.id)}
                  className={`-mb-px border-b-2 px-4 py-2 text-sm transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink ${
                    t.id === active.id ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
                  }`}
                >
                  {t.title}
                </button>
              ))}
            </div>
            <div key={`${nct}:${criterionId}:${active.id}`} role="tabpanel" className="flex flex-1 flex-col pt-6">
              {active.render({ nct, criterionId })}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
