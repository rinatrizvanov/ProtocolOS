"use client";

import { getReview, type Classification, type Criterion } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Failed, Frame, Pending } from "../components/Frame";

const TILE_CLASS: Record<Classification, string> = {
  "Review recommended": "bg-look-soft border-look",
  "Evidence supports retaining": "bg-support-soft border-support",
  "Insufficient evidence": "bg-uncounted-soft border-uncounted",
};

const LEGEND: { classification: Classification; text: string; swatch: string }[] = [
  { classification: "Review recommended", text: "look again", swatch: "bg-look" },
  { classification: "Evidence supports retaining", text: "evidence supports", swatch: "bg-support" },
  { classification: "Insufficient evidence", text: "not enough evidence", swatch: "bg-uncounted" },
];

function threshold(c: Criterion): string {
  if (c.value_norm === null) return "no numeric limit";
  return `${c.operator} ${c.value_norm}${c.unit_norm ? ` ${c.unit_norm}` : ""}`;
}

export default function Screen1({ nct }: { nct: string }) {
  const state = useApi(() => getReview(nct));
  if (state.status === "loading") return <Pending label="Loading the review…" />;
  if (state.status === "error") return <Failed message={state.message} />;
  const { target, reviews } = state.data;
  const study = target.study;
  const counts = LEGEND.map((l) => ({ ...l, n: reviews.filter((r) => r.classification === l.classification).length }));

  return (
    <Frame
      headline="Who gets into a trial?"
      caption="TrialLens checks each rule against evidence; amber means the team should look again."
      details={
        <>
          <ul>
            {counts.map((c) => (
              <li key={c.classification}>
                {c.classification}: <span className="tabular-nums">{c.n}</span>
              </li>
            ))}
          </ul>
          <p>Sponsor: {study.sponsor}</p>
          <p>Start date: {study.start_date}</p>
          <p>
            Enrollment: <span className="tabular-nums">{study.enrollment.count}</span> ({study.enrollment.type})
          </p>
        </>
      }
    >
      <div className="flex w-full flex-col gap-5">
        <p data-testid="trial-name" className="text-2xl font-semibold text-ink">
          {study.acronym ?? study.title} <span className="text-sm font-normal text-muted">{study.nct_id}</span>
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {reviews.map((r) => (
            <div
              key={r.criterion.id}
              data-testid="rule-tile"
              data-criterion={r.criterion.id}
              data-classification={r.classification}
              className={`rounded-lg border-l-4 p-4 ${TILE_CLASS[r.classification]}`}
            >
              <p className="text-base font-medium text-ink">{r.criterion.label}</p>
              <p className="mt-1 text-2xl tabular-nums text-ink">{threshold(r.criterion)}</p>
            </div>
          ))}
        </div>
        <p className="flex flex-wrap gap-5 text-sm text-muted">
          {LEGEND.map((l) => (
            <span key={l.classification} className="flex items-center gap-2">
              <span aria-hidden className={`inline-block h-3 w-3 rounded-sm ${l.swatch}`} />
              {l.text}
            </span>
          ))}
        </p>
      </div>
    </Frame>
  );
}
