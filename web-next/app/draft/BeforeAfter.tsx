"use client";

import { useEffect, useState } from "react";
import { DISPLAY_CLASSIFICATION, type Draft, type DraftCriterion } from "@/lib/contracts";
import { ConditionMark, draftHasCondition, fmt, hasCondition, Icon, sourceOf, valueText, WARN } from "./DraftCard";

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
  source?: { page: number | null; url: string; text: string };
}
export interface ReviewLite {
  target: { study: { nct_id: string; acronym: string | null; title: string; start_date: string | null } };
  // An uploaded protocol's review (trialforge/upload.py) also carries the classification of each written value.
  reviews: { criterion: ReviewCriterion; classification?: keyof typeof DISPLAY_CLASSIFICATION }[];
}

// A protocol supplied by the page instead of fetched by NCT: the visitor's uploaded protocol.
export interface WrittenProtocol {
  review: ReviewLite;
  title: string;
  note: string;
}

interface Row {
  c: DraftCriterion;
  // null when no criterion for this analyte was extracted from the protocol.
  written: string | null;
  writtenCondition: boolean;
  // href is null for an uploaded protocol, which has no public address.
  source: { href: string | null; page: number } | null;
  writtenReview: string | null;
  drafted: string | null;
  differs: boolean;
  // Set when the two sides state different measures (renal: GFR vs creatinine clearance); such a row is not compared.
  measure: { written: string; drafted: string; writtenLabel: string } | null;
  // How many of the earlier trials that state this criterion used the protocol's written value (k of n), and how many
  // regimen-matched precedents the draft read in all.
  used: { k: number; n: number; total: number };
}

const sameValue = (a: { operator: string; value: number; unit: string }, op: string, v: number, u: string) =>
  a.operator === op && a.unit === u && Math.abs(a.value - v) < 1e-9;

// Same rule as the engine's comparators.renal_measure: GFR when the label or the source wording says so.
const renalMeasure = (text: string) => (/GFR|glomerular/i.test(text) ? "GFR" : "CrCl");
const prettyUnit = (u: string) => u.replace(/m2$/, "m²");

function toRow(c: DraftCriterion, w: ReviewCriterion | undefined, total: number, writtenReview: string | null = null): Row {
  const n = c.distribution.reduce((sum, d) => sum + d.count, 0);
  const drafted = c.proposed ? valueText(c.proposed.operator, c.proposed.value, c.proposed.unit, c.label) : null;
  if (!w) return { c, written: null, writtenCondition: false, source: null, writtenReview, drafted, differs: true, measure: null, used: { k: 0, n, total } };
  const page = w.source?.page;
  const source = page ? { href: w.source?.url ? `${w.source.url}#page=${page}` : null, page } : null;
  const writtenCondition = hasCondition(w.source?.text);
  if (c.analyte === "renal" && c.proposed) {
    const mw = renalMeasure(`${w.label} ${w.source?.text ?? ""}`);
    const md = renalMeasure(`${c.label} ${sourceOf(c)?.quote ?? ""}`);
    if (mw !== md) {
      // The normalized unit drops "/1.73m2"; a different measure is shown as written, with its own label and unit.
      const written = w.value !== null ? `${w.operator}${fmt(w.value)} ${prettyUnit(w.unit ?? "")}`.trim() : `${w.operator}?`;
      return { c, written, writtenCondition, source, writtenReview, drafted, differs: false, measure: { written: mw, drafted: md, writtenLabel: w.label }, used: { k: 0, n, total } };
    }
  }
  const wv = w.value_norm ?? w.value;
  const wu = w.unit_norm ?? w.unit ?? "";
  const same = c.proposed !== null && wv !== null && sameValue(c.proposed, w.operator, wv, wu);
  const k = wv === null ? 0 : (c.distribution.find((d) => sameValue(d, w.operator, wv, wu))?.count ?? 0);
  return {
    c,
    written: wv !== null ? valueText(w.operator, wv, wu, c.label) : `${w.operator}?`,
    writtenCondition,
    source,
    writtenReview,
    drafted,
    differs: c.proposed !== null && !same,
    measure: null,
    used: { k, n, total },
  };
}

const trials = (n: number) => `${n} earlier trial${n === 1 ? "" : "s"}`;

function Question({ row }: { row: Row }) {
  if (row.measure) {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-ink">
        <Icon d={WARN} className="text-look" />
        Different measure ({row.measure.written} vs {row.measure.drafted}): ask which the team intends
      </span>
    );
  }
  if (row.drafted === null) return <span className="text-muted">No precedent value to compare</span>;
  if (!row.differs) return <span className="text-muted">Same as drafted</span>;
  const { k, n, total } = row.used;
  return (
    <span className="inline-flex flex-col gap-0.5">
      <span className="inline-flex items-center gap-1 font-medium text-ink">
        <Icon d={WARN} className="text-look" />
        {row.written === null ? "Not extracted from the protocol: check it" : "Differs: ask why"}
      </span>
      <span data-role="used" className="text-muted">
        {row.written === null ? `${n} of ${trials(total)} state it` : k > 0 ? `${k} of ${trials(n)} used it` : "no earlier trial used it"}
      </span>
    </span>
  );
}

// On /draft the label opens and scrolls to the card; the guided tour shows no cards next to this table, so it is plain text.
function CriterionLink({ c, onOpen }: { c: DraftCriterion; onOpen?: (id: string) => void }) {
  if (!onOpen) return <span className="font-medium text-ink">{c.label}</span>;
  return (
    <a href={`#draft-${c.id}`} onClick={() => onOpen(c.id)} className="font-medium text-ink underline decoration-line underline-offset-2 hover:decoration-ink">
      {c.label}
    </a>
  );
}

function Written({ row }: { row: Row }) {
  if (row.written === null) return <span className="text-muted">Not extracted</span>;
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {row.written}
        {row.source?.href ? (
          <a
            href={row.source.href}
            target="_blank"
            rel="noreferrer"
            className="-mx-1 -my-1 inline-block rounded px-1 py-1 text-xs text-muted underline decoration-line underline-offset-2 hover:text-ink"
          >
            p.{row.source.page}
          </a>
        ) : row.source ? (
          <span className="text-xs text-muted">p.{row.source.page}</span>
        ) : null}
        {row.writtenCondition ? <ConditionMark short /> : null}
      </span>
      {row.measure ? <span className="text-xs text-muted">{row.measure.writtenLabel}</span> : null}
      {row.writtenReview ? <span data-role="written-review" className="text-xs text-muted">Review: {row.writtenReview}</span> : null}
    </span>
  );
}

function Drafted({ row }: { row: Row }) {
  if (row.drafted === null) return <span className="text-muted">Insufficient evidence</span>;
  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {row.drafted}
        {draftHasCondition(row.c) ? <ConditionMark short /> : null}
      </span>
      {row.measure ? <span className="text-xs text-muted">{row.c.label}</span> : null}
    </span>
  );
}

const rowTone = (row: Row) => (row.measure || row.differs ? "bg-look-soft/50" : "");

// Compares the protocol as written with the criteria drafted from trials that started before it. A difference is a
// question for the team, not an error in either.
export default function BeforeAfter({
  draft,
  nct = null,
  written: supplied = null,
  presetTitle = null,
  onOpen,
}: {
  draft: Draft;
  nct?: string | null;
  written?: WrittenProtocol | null;
  presetTitle?: string | null;
  onOpen?: (id: string) => void;
}) {
  const [fetched, setReview] = useState<ReviewLite | null>(null);
  const [failed, setFailed] = useState(false);
  const review = supplied?.review ?? fetched;
  useEffect(() => {
    if (!nct) return;
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

  const written = new Map(review.reviews.map((r) => [r.criterion.analyte ?? r.criterion.id, r]));
  const reviewOf = (key: string) => {
    const cls = written.get(key)?.classification;
    return cls ? DISPLAY_CLASSIFICATION[cls] : null;
  };
  // A drafted criterion the protocol does not state is a difference too; an insufficient one with nothing written is not shown.
  const rows = draft.criteria
    .filter((c) => written.has(c.analyte) || c.proposed !== null)
    .map((c) => toRow(c, written.get(c.analyte)?.criterion, draft.precedents.length, reviewOf(c.analyte)));
  // Criteria the protocol states that the draft has no counterpart for (an uploaded protocol may state more).
  const drafted = new Set(draft.criteria.map((c) => c.analyte));
  const extra = supplied ? review.reviews.filter((r) => !drafted.has(r.criterion.analyte ?? r.criterion.id)) : [];
  const comparable = rows.filter((r) => !r.measure).length;
  const differing = rows.filter((r) => r.differs).length;
  const otherMeasure = rows.length - comparable;
  const study = review.target.study;

  return (
    <section data-testid="before-after" aria-labelledby="before-after-title" className="flex flex-col gap-2">
      <div>
        <h2 id="before-after-title" className="text-lg font-semibold text-ink">
          {supplied
            ? `Drafted from precedents vs. your protocol (${supplied.title})`
            : `Drafted at design time vs. the protocol as written (${study.acronym ?? study.nct_id})`}
        </h2>
        <p className="text-sm text-muted">
          {supplied ? (
            supplied.note
          ) : (
            <>
              {presetTitle ? `${presetTitle}. ` : ""}Registry title: {study.title}, started {study.start_date}. The draft uses only trials that started
              earlier.
            </>
          )}{" "}
          Differences are review questions, not mistakes.
        </p>
      </div>
      <p data-testid="before-after-count" className="text-sm text-ink">
        <span className="text-2xl font-semibold tabular-nums tracking-tight">
          {differing} of {comparable}
        </span>{" "}
        criteria differ from the value drafted from earlier trials
        {otherMeasure ? (
          <span className="text-muted">
            {" "}
            · {otherMeasure} states a different measure
          </span>
        ) : null}
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
              <tr key={row.c.id} data-differs={row.differs} data-measure={row.measure ? "different" : undefined} className={`border-t border-line align-top ${rowTone(row)}`}>
                <th scope="row" className="px-3 py-2 font-normal">
                  <CriterionLink c={row.c} onOpen={onOpen} />
                </th>
                <td className="px-3 py-2 tabular-nums text-ink">
                  <Written row={row} />
                </td>
                <td className="px-3 py-2 tabular-nums text-ink">
                  <Drafted row={row} />
                </td>
                <td className="px-3 py-2 text-[13px]">
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
            data-measure={row.measure ? "different" : undefined}
            className={`rounded-lg border px-3 py-2 text-sm ${row.measure || row.differs ? "border-look/40 bg-look-soft/50" : "border-line bg-white"}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <CriterionLink c={row.c} onOpen={onOpen} />
              <span className="text-[13px]">
                <Question row={row} />
              </span>
            </div>
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]">
              <dt className="text-muted">As written</dt>
              <dd className="tabular-nums text-ink">
                <Written row={row} />
              </dd>
              <dt className="text-muted">Drafted</dt>
              <dd className="tabular-nums text-ink">
                <Drafted row={row} />
              </dd>
            </dl>
          </li>
        ))}
      </ul>

      {extra.length ? (
        <div data-testid="before-after-extra" className="flex flex-col gap-1 text-sm">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Also in your protocol, with no drafted counterpart</h3>
          <ul className="flex flex-col gap-1">
            {extra.map((r) => (
              <li key={r.criterion.id} className="flex flex-wrap gap-x-2 text-[13px] text-ink">
                <span className="font-medium">{r.criterion.label}</span>
                <span className="tabular-nums">
                  {r.criterion.operator}
                  {r.criterion.value_norm !== null ? fmt(r.criterion.value_norm) : "?"} {r.criterion.unit_norm ?? ""}
                </span>
                {r.criterion.source?.page ? <span className="text-muted">p.{r.criterion.source.page}</span> : null}
                {r.classification ? <span className="text-muted">Review: {DISPLAY_CLASSIFICATION[r.classification]}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
