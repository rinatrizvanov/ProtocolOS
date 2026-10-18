"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { getProtocolPage, getReview, type ComparatorRow, type ProtocolPage, type Selection } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Failed, Frame, Pending } from "../components/Frame";

type Stated = ComparatorRow & { criterion: NonNullable<ComparatorRow["criterion"]> };
type Plotted = Stated & { criterion: { value_norm: number } };

function isStated(row: ComparatorRow): row is Stated {
  return row.criterion !== null;
}

function isPlotted(row: ComparatorRow): row is Plotted {
  return row.criterion !== null && row.criterion.value_norm !== null;
}

function highlight(text: string, needle: string): ReactNode {
  const at = needle ? text.indexOf(needle) : -1;
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark>{needle}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

export function ProtocolDrawer({
  nct,
  page: pageNumber,
  quote,
  fallback,
  title,
  onClose,
}: {
  nct: string;
  page: number;
  quote: string;
  fallback?: string;
  title: string;
  onClose: () => void;
}) {
  const [page, setPage] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: ProtocolPage }>({ status: "loading" });
  useEffect(() => {
    let live = true;
    getProtocolPage(nct, pageNumber).then(
      (data) => live && setPage({ status: "ready", data }),
      (err: unknown) => live && setPage({ status: "error", message: err instanceof Error ? err.message : String(err) }),
    );
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      live = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [nct, pageNumber, onClose]);
  const needle = page.status === "ready" && page.data.text.includes(quote) ? quote : (fallback ?? quote);

  return (
    <aside role="dialog" aria-modal="true" aria-label="Protocol page" data-testid="protocol-drawer" className="fixed inset-y-0 right-0 z-20 flex w-full max-w-xl flex-col gap-3 border-l border-line bg-paper p-6 shadow-lg">
      <div className="flex items-center justify-between">
        <p className="text-xl font-semibold text-ink">
          {title}, page <span className="tabular-nums">{pageNumber}</span>
        </p>
        <button type="button" onClick={onClose} className="rounded border border-line px-3 py-1 text-ink focus-visible:outline focus-visible:outline-2">
          Close
        </button>
      </div>
      {page.status === "loading" && <Pending label="Loading the protocol page…" />}
      {page.status === "error" && <Failed message={page.message} />}
      {page.status === "ready" && (
        <>
          <a href={page.data.url} target="_blank" rel="noreferrer" className="text-sm text-ink underline">
            Open the protocol PDF
          </a>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap font-sans text-sm text-ink">{highlight(page.data.text, needle)}</pre>
        </>
      )}
    </aside>
  );
}

// Label column and scale column; the header, every trial row and the footer share it so the scale lines up.
const ROW = "grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-4 sm:grid-cols-[14rem_minmax(0,1fr)]";

// `detailed` is the app's Compare tab (sponsor and regimen lines); the tour keeps the short labels.
export default function Screen2({ nct, criterionId, detailed = false }: Selection & { detailed?: boolean }) {
  const state = useApi(() => getReview(nct));
  const [open, setOpen] = useState<Stated | null>(null);
  const closeDrawer = useCallback(() => setOpen(null), []);
  if (state.status === "loading") return <Pending label="Loading the comparison…" />;
  if (state.status === "error") return <Failed message={state.message} />;
  const rows = state.data.comparison[criterionId] ?? [];
  const target = state.data.reviews.find((r) => r.criterion.id === criterionId)?.criterion;
  if (!target || target.value_norm === null) return <Failed message={`no numeric ${criterionId} limit in the review`} />;
  const targetValue = target.value_norm;
  // A limit on a different measure is not on this trial's scale; the engine does not compare it, so it is listed, not plotted.
  const otherMeasure = rows.filter((r): r is Stated => isStated(r) && r.direction === "different measure");
  const comparable = rows.filter((r) => r.direction !== "different measure");
  const plotted = comparable.filter(isPlotted);
  const withCriterion = comparable.filter(isStated);
  const sponsors = new Map(state.data.comparators.map((c) => [c.study.nct_id, c.study.sponsor]));
  const looser = withCriterion.filter((r) => r.direction === "comparator looser").length;
  // Operators arrive as Unicode (≥, >); a looser comparator for a floor is a lower limit.
  const floor = /[>≥]/.test(target.operator);
  const word = floor ? "lower" : "higher";
  const values = [targetValue, ...plotted.map((r) => r.criterion.value_norm)];
  const pad = Math.max(0.5, (Math.max(...values) - Math.min(...values)) * 0.2);
  const lo = Math.min(...values) - pad;
  const hi = Math.max(...values) + pad;
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const caption =
    state.data.comparators.length === 0
      ? "No similar trial was found for this protocol."
      : withCriterion.length === 0 && otherMeasure.length > 0
        ? "The similar trials that state this criterion use a different measure; not directly comparable."
        : withCriterion.length === 0
          ? "None of the similar trials states this criterion."
          : `${looser} of ${withCriterion.length} similar trials used a ${word} limit; differences are questions for the team.`;
  const at = pct(targetValue);
  // Text near an edge grows inward: translating by -at% keeps the block inside the track at any width.
  const align = at < 34 ? "text-left" : at > 66 ? "text-right" : "text-center";
  const unit = target.unit_norm ?? "";

  return (
    <Frame
      headline="One rule, compared."
      caption={caption}
      details={
        rows.length > 0 ? (
          <ul className="list-disc pl-5">
            {rows.map((r) => (
              <li key={r.nct_id}>
                {r.acronym ?? r.nct_id}: {r.criterion ? `${r.direction}, coverage ${r.coverage.status}` : "not found"}
              </li>
            ))}
          </ul>
        ) : undefined
      }
    >
      {/* One row per similar trial on a shared scale; the vertical line is this trial's limit. Rows never overlap, so the plot fits any width. */}
      <div className="flex w-full max-w-4xl flex-col">
        <div className={ROW}>
          <span className="self-end pb-1 text-xs font-medium uppercase tracking-wide text-muted">Similar trial</span>
          <div className="relative h-16">
            <div
              data-testid="target-marker"
              data-value={targetValue}
              className={`absolute top-0 whitespace-nowrap ${align}`}
              style={{ left: `${at}%`, transform: `translateX(-${at}%)` }}
            >
              <p className="text-xs text-muted">this trial</p>
              <p className="text-2xl font-semibold leading-tight tabular-nums text-ink">
                {target.operator} {targetValue} <span className="text-sm font-normal text-muted">{unit}</span>
              </p>
            </div>
            <span className="absolute bottom-0 h-2 w-0.5 -translate-x-1/2 bg-ink" style={{ left: `${at}%` }} />
          </div>
        </div>
        {plotted.length === 0 && otherMeasure.length === 0 ? (
          <p className="border-t border-line py-3 text-sm text-muted">No similar trial&apos;s limit to plot.</p>
        ) : null}
        {plotted.map((r) => {
          const v = pct(r.criterion.value_norm);
          return (
            <button
              key={r.nct_id}
              type="button"
              data-testid="comparator-dot"
              data-nct={r.nct_id}
              data-value={r.criterion.value_norm}
              onClick={() => setOpen(r)}
              title="Open the protocol page this limit comes from"
              className={`${ROW} border-t border-line text-left transition-colors duration-150 hover:bg-line/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink`}
            >
              <span className="flex min-w-0 flex-col py-2">
                <span className="text-sm text-ink">
                  <span className="font-medium">{r.acronym ?? r.nct_id}</span>{" "}
                  <span className="tabular-nums text-muted">{r.criterion.value_norm}</span>
                </span>
                {detailed ? (
                  <span className="flex flex-col text-xs text-muted">
                    <span data-testid="comparator-sponsor">{sponsors.get(r.nct_id)}</span>
                    {r.coverage.status === "full" ? <span>same chemo classes</span> : null}
                    {r.direction === "same" ? <span>same limit (may be copied from older templates)</span> : null}
                  </span>
                ) : null}
              </span>
              <span aria-hidden className="relative self-stretch">
                <span className="absolute inset-x-0 top-1/2 h-px bg-line" />
                <span
                  className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-look/40"
                  style={{ left: `${Math.min(v, at)}%`, width: `${Math.abs(v - at)}%` }}
                />
                <span className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-ink" style={{ left: `${at}%` }} />
                <span
                  className="absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-look ring-2 ring-paper"
                  style={{ left: `${v}%` }}
                />
              </span>
            </button>
          );
        })}
        {plotted.length > 0 ? (
          <div className={`${ROW} border-t border-line pt-1`}>
            <span />
            <span className="flex justify-between gap-2 text-xs text-muted">
              <span>{floor ? "less strict" : "stricter"}</span>
              <span>{unit}</span>
              <span>{floor ? "stricter" : "less strict"}</span>
            </span>
          </div>
        ) : null}
        {otherMeasure.length > 0 ? (
          <div data-testid="other-measure" className="flex flex-col gap-1 border-t border-line py-3 text-sm">
            <p className="text-muted">Different measure, not directly comparable, so not plotted:</p>
            <ul className="flex flex-col gap-1">
              {otherMeasure.map((r) => (
                <li key={r.nct_id}>
                  <button
                    type="button"
                    data-testid="other-measure-row"
                    data-nct={r.nct_id}
                    onClick={() => setOpen(r)}
                    title="Open the protocol page this limit comes from"
                    className="text-left text-ink underline decoration-line underline-offset-2 transition-colors duration-150 hover:decoration-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
                  >
                    <span className="font-medium">{r.acronym ?? r.nct_id}</span> {r.criterion.label}{" "}
                    <span className="tabular-nums">
                      {r.criterion.operator} {r.criterion.value_norm ?? ""} {r.criterion.unit_norm ?? ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {open && (
        <ProtocolDrawer
          nct={open.nct_id}
          page={open.criterion.source.page}
          quote={open.criterion.source.text}
          fallback={open.criterion.value_norm === null ? undefined : String(open.criterion.value_norm)}
          title={open.acronym ?? open.nct_id}
          onClose={closeDrawer}
        />
      )}
    </Frame>
  );
}
