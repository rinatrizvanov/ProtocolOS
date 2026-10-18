"use client";

import { useEffect, useState } from "react";
import type { Draft, DraftCriterion } from "@/lib/contracts";
import { fmt, Icon, WARN } from "./DraftCard";

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
  target: { study: { nct_id: string; acronym: string | null; title: string; start_date: string } };
  reviews: { criterion: ReviewCriterion }[];
}

interface Row {
  c: DraftCriterion;
  // null when no criterion for this analyte was extracted from the protocol.
  written: string | null;
  source: { href: string; page: number } | null;
  drafted: string | null;
  differs: boolean;
  // How many of the earlier trials that state this criterion used the protocol's written value (k of n), and how many
  // regimen-matched precedents the draft read in all.
  used: { k: number; n: number; total: number };
}

const sameValue = (a: { operator: string; value: number; unit: string }, op: string, v: number, u: string) =>
  a.operator === op && a.unit === u && Math.abs(a.value - v) < 1e-9;

function toRow(c: DraftCriterion, w: ReviewCriterion | undefined, total: number): Row {
  const n = c.distribution.reduce((sum, d) => sum + d.count, 0);
  const drafted = c.proposed ? `${c.proposed.operator}${fmt(c.proposed.value)} ${c.proposed.unit}` : null;
  if (!w) return { c, written: null, source: null, drafted, differs: true, used: { k: 0, n, total } };
  const wv = w.value_norm ?? w.value;
  const wu = w.unit_norm ?? w.unit ?? "";
  const same = c.proposed !== null && wv !== null && sameValue(c.proposed, w.operator, wv, wu);
  const k = wv === null ? 0 : (c.distribution.find((d) => sameValue(d, w.operator, wv, wu))?.count ?? 0);
  return {
    c,
    written: `${w.operator}${wv !== null ? fmt(wv) : "?"} ${wu}`.trim(),
    source: w.source ? { href: `${w.source.url}#page=${w.source.page}`, page: w.source.page } : null,
    drafted,
    differs: c.proposed !== null && !same,
    used: { k, n, total },
  };
}

const trials = (n: number) => `${n} earlier trial${n === 1 ? "" : "s"}`;

function Question({ row }: { row: Row }) {
  if (row.drafted === null) return <span className="text-muted">No precedent value to compare</span>;
  if (!row.differs) return <span className="text-muted">Same as drafted</span>;
  const { k, n, total } = row.used;
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1 font-medium text-ink">
        <Icon d={WARN} className="text-look" />
        {row.written === null ? "Not found in the protocol: ask why" : "Differs: ask why"}
      </span>
      <span data-role="used" className="text-muted">
        {row.written === null ? `${n} of ${trials(total)} state it` : k > 0 ? `${k} of ${trials(n)} used it` : "no earlier trial used it"}
      </span>
    </span>
  );
}

function CriterionLink({ c }: { c: DraftCriterion }) {
  return (
    <a href={`#draft-${c.id}`} className="font-medium text-ink underline decoration-line underline-offset-2 hover:decoration-ink">
      {c.label}
    </a>
  );
}

function Written({ row }: { row: Row }) {
  if (row.written === null) return <span className="text-muted">Not found</span>;
  return (
    <>
      {row.written}
      {row.source ? (
        <a href={row.source.href} target="_blank" rel="noreferrer" className="ml-1 text-xs text-muted underline decoration-line underline-offset-2">
          p.{row.source.page}
        </a>
      ) : null}
    </>
  );
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
  // A drafted criterion the protocol does not state is a difference too; an insufficient one with nothing written is not shown.
  const rows = draft.criteria
    .filter((c) => written.has(c.analyte) || c.proposed !== null)
    .map((c) => toRow(c, written.get(c.analyte), draft.precedents.length));
  const differing = rows.filter((r) => r.differs).length;
  const study = review.target.study;

  return (
    <section data-testid="before-after" aria-labelledby="before-after-title" className="flex flex-col gap-2">
      <div>
        <h2 id="before-after-title" className="text-lg font-semibold text-ink">
          Drafted at design time vs. {study.acronym ?? study.nct_id} as written
        </h2>
        <p className="text-sm text-muted">
          {study.title}, started {study.start_date}. The draft uses only trials that started earlier. Differences are review questions, not mistakes.
        </p>
      </div>
      <p data-testid="before-after-count" className="text-sm font-medium text-ink">
        {differing} of {rows.length} criteria differ from the value drafted from earlier trials
      </p>

      <div className="hidden overflow-hidden rounded-lg border border-line bg-white sm:block">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Differences are review questions</caption>
          <thead className="bg-uncounted-soft text-xs text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Criterion</th>
              <th scope="col" className="px-3 py-2 font-medium">Protocol as written</th>
              <th scope="col" className="px-3 py-2 font-medium">Drafted from precedents</th>
              <th scope="col" className="px-3 py-2 font-medium">Review question</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.c.id} data-differs={row.differs} className={`border-t border-line align-top ${row.differs ? "bg-look-soft/50" : ""}`}>
                <th scope="row" className="px-3 py-2 font-normal">
                  <CriterionLink c={row.c} />
                </th>
                <td className="px-3 py-2 tabular-nums text-ink">
                  <Written row={row} />
                </td>
                <td className="px-3 py-2 tabular-nums text-ink">{row.drafted ?? <span className="text-muted">Insufficient evidence</span>}</td>
                <td className="px-3 py-2 text-xs">
                  <Question row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-2 sm:hidden" aria-label="Differences are review questions">
        {rows.map((row) => (
          <li
            key={row.c.id}
            data-differs={row.differs}
            className={`rounded-lg border px-3 py-2 text-sm ${row.differs ? "border-look/40 bg-look-soft/50" : "border-line bg-white"}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <CriterionLink c={row.c} />
              <span className="text-xs">
                <Question row={row} />
              </span>
            </div>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
              <dt className="text-muted">As written</dt>
              <dd className="tabular-nums text-ink">
                <Written row={row} />
              </dd>
              <dt className="text-muted">Drafted</dt>
              <dd className="tabular-nums text-ink">{row.drafted ?? "Insufficient evidence"}</dd>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  );
}
