"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { getProtocolPage, getReview, type ComparatorRow, type ProtocolPage, type Selection } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Failed, Frame, Pending } from "../components/Frame";

type Plotted = ComparatorRow & { criterion: NonNullable<ComparatorRow["criterion"]> & { value_norm: number } };

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

export default function Screen2({ nct, criterionId }: Selection) {
  const state = useApi(() => getReview(nct));
  const [open, setOpen] = useState<Plotted | null>(null);
  const closeDrawer = useCallback(() => setOpen(null), []);
  if (state.status === "loading") return <Pending label="Loading the comparison…" />;
  if (state.status === "error") return <Failed message={state.message} />;
  const rows = state.data.comparison[criterionId] ?? [];
  const target = state.data.reviews.find((r) => r.criterion.id === criterionId)?.criterion;
  if (!target || target.value_norm === null) return <Failed message={`no numeric ${criterionId} limit in the review`} />;
  const targetValue = target.value_norm;
  const plotted = rows.filter(isPlotted);
  const withCriterion = rows.filter((r) => r.criterion !== null);
  const looser = withCriterion.filter((r) => r.direction === "comparator looser").length;
  // Operators arrive as Unicode (≥, >); a looser comparator for a floor is a lower limit.
  const word = /[>≥]/.test(target.operator) ? "lower" : "higher";
  const values = [targetValue, ...plotted.map((r) => r.criterion.value_norm)];
  const pad = Math.max(0.5, (Math.max(...values) - Math.min(...values)) * 0.2);
  const lo = Math.min(...values) - pad;
  const hi = Math.max(...values) + pad;
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const caption = `${looser} of ${withCriterion.length} similar trials used a ${word} limit; differences are questions for the team.`;

  return (
    <Frame
      headline="One rule, compared."
      caption={caption}
      details={
        <ul className="list-disc pl-5">
          {rows.map((r) => (
            <li key={r.nct_id}>
              {r.acronym ?? r.nct_id}: {r.criterion ? `${r.direction}, coverage ${r.coverage.status}` : "not found"}
            </li>
          ))}
        </ul>
      }
    >
      <div className="relative w-full max-w-4xl px-8 pt-24 pb-52">
        <div className="h-0.5 w-full bg-line" />
        <div
          data-testid="target-marker"
          data-value={targetValue}
          className="absolute top-8 -translate-x-1/2 text-center"
          style={{ left: `calc(2rem + (100% - 4rem) * ${pct(targetValue) / 100})` }}
        >
          <p className="text-sm text-muted">this trial</p>
          <p className="text-3xl font-semibold tabular-nums text-ink">
            {target.operator} {targetValue}
          </p>
          {/* Stops at the axis so comparator dots with the same value stay readable below it. */}
          <div className="mx-auto h-4 w-1.5 bg-ink" />
        </div>
        {plotted.map((r, i) => {
          // Trials that used the same value stack in their own rows so each dot stays clickable.
          const lane = plotted.slice(0, i).filter((o) => o.criterion.value_norm === r.criterion.value_norm).length;
          return (
          <button
            key={r.nct_id}
            type="button"
            data-testid="comparator-dot"
            data-nct={r.nct_id}
            data-value={r.criterion.value_norm}
            onClick={() => setOpen(r)}
            className="absolute -translate-x-1/2 text-center focus-visible:outline focus-visible:outline-2"
            style={{ left: `calc(2rem + (100% - 4rem) * ${pct(r.criterion.value_norm) / 100})`, top: `${6.6 + lane * 2.9}rem` }}
          >
            <span className="mx-auto block h-4 w-4 rounded-full bg-look" />
            <span className="block whitespace-nowrap text-sm text-ink">
              {r.acronym ?? r.nct_id} <span className="tabular-nums text-muted">{r.criterion.value_norm}</span>
            </span>
          </button>
          );
        })}
        <p className="absolute bottom-2 right-8 text-sm text-muted">{target.unit_norm ?? "g/dL"}</p>
      </div>
      {open && (
        <ProtocolDrawer
          nct={open.nct_id}
          page={open.criterion.source.page}
          quote={open.criterion.source.text}
          fallback={String(open.criterion.value_norm)}
          title={open.acronym ?? open.nct_id}
          onClose={closeDrawer}
        />
      )}
    </Frame>
  );
}
