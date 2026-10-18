"use client";

import { useEffect, useState } from "react";
import type { Draft } from "@/lib/contracts";

// Only the fields this table reads from GET /api/review/{nct}.
interface ReviewCriterion {
  id: string;
  analyte?: string;
  label: string;
  operator: string;
  value: number | null;
  unit: string | null;
  value_norm: number | null;
  unit_norm: string | null;
  source?: { page: number; url: string; text: string };
}
interface ReviewLite {
  target: { study: { nct_id: string; acronym: string | null; start_date: string } };
  reviews: { criterion: ReviewCriterion }[];
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
}

// Compares the protocol as written with the criteria drafted from trials that started before it. A difference is a
// question for the team, not an error in either.
export default function BeforeAfter({ draft, nct }: { draft: Draft; nct: string }) {
  const [review, setReview] = useState<ReviewLite | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`/api/review/${encodeURIComponent(nct)}`)
      .then((r) => (r.ok ? (r.json() as Promise<ReviewLite>) : Promise.reject(new Error(String(r.status)))))
      .then((d) => live && setReview(d))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [nct]);

  if (failed) return <p className="text-sm text-muted">Could not load the protocol for the comparison.</p>;
  if (!review) return <p className="text-sm text-muted">Loading the protocol as written…</p>;

  const written = new Map(review.reviews.map((r) => [r.criterion.analyte ?? r.criterion.id, r.criterion]));
  const rows = draft.criteria.filter((c) => written.has(c.analyte));
  const study = review.target.study;

  return (
    <section data-testid="before-after" className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold text-ink">
        Drafted at design time vs. {study.acronym ?? study.nct_id} as written
      </h2>
      <p className="text-sm text-muted">
        Drafted only from trials that started before {study.start_date}. Differences are review questions, not mistakes.
      </p>
      <div className="overflow-x-auto rounded-lg border border-line bg-white">
        <table className="w-full min-w-[34rem] text-left text-sm">
          <caption className="sr-only">Differences are review questions</caption>
          <thead className="bg-uncounted-soft text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">Criterion</th>
              <th className="px-3 py-2 font-medium">Protocol as written</th>
              <th className="px-3 py-2 font-medium">Drafted from precedents</th>
              <th className="px-3 py-2 font-medium">Review question</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const w = written.get(c.analyte)!;
              const wv = w.value_norm ?? w.value;
              const wu = w.unit_norm ?? w.unit ?? "";
              const same =
                c.proposed !== null && wv !== null && c.proposed.operator === w.operator && Math.abs(c.proposed.value - wv) < 1e-9;
              return (
                <tr key={c.id} className="border-t border-line align-top">
                  <td className="px-3 py-2 font-medium text-ink">{c.label}</td>
                  <td className="px-3 py-2 tabular-nums text-ink">
                    {w.operator}
                    {wv !== null ? fmt(wv) : "?"} {wu}
                    {w.source ? (
                      <a href={`${w.source.url}#page=${w.source.page}`} target="_blank" rel="noreferrer" className="ml-1 text-xs text-muted underline decoration-line underline-offset-2">
                        p.{w.source.page}
                      </a>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-ink">
                    {c.proposed ? `${c.proposed.operator}${fmt(c.proposed.value)} ${c.proposed.unit}` : <span className="text-muted">Insufficient evidence</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted">
                    {c.proposed === null ? "No precedent value to compare" : same ? "Same as precedents" : "Differs: ask why"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">Differences are review questions.</p>
    </section>
  );
}
