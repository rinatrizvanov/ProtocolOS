"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { getProtocolPage, getReview, isPolicy, requirementText, type ComparatorRow, type Criterion, type ProtocolPage, type Selection } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Failed, Frame, Pending } from "../components/Frame";
import { COVERAGE_TEXT, DIRECTION_TEXT, fmtLimit, sameKind, sameText } from "./limits";

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

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

// A modal side sheet: focus moves in on open, Tab stays inside, Escape or the scrim closes it, and focus returns to the
// row that opened it. The protocol text it shows is data, never instructions.
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
  const panel = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    let live = true;
    getProtocolPage(nct, pageNumber).then(
      (data) => live && setPage({ status: "ready", data }),
      (err: unknown) => live && setPage({ status: "error", message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [nct, pageNumber]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = panel.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [onClose]);

  const needle = page.status === "ready" && page.data.text.includes(quote) ? quote : (fallback ?? quote);

  return (
    <>
      <div aria-hidden data-testid="protocol-drawer-scrim" onClick={onClose} className="fixed inset-0 z-20 bg-ink/30" />
      <aside
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="protocol-drawer"
        className="fixed inset-y-0 right-0 z-30 flex w-full max-w-xl flex-col gap-3 border-l border-line bg-paper p-4 shadow-lg sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-xl font-semibold text-ink">
            {title}, page <span className="tabular-nums">{pageNumber}</span>
          </h2>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            className="min-h-11 shrink-0 rounded border border-uncounted px-3 py-1 text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink sm:min-h-9"
          >
            Close
          </button>
        </div>
        {page.status === "loading" && <Pending label="Loading the protocol page…" />}
        {page.status === "error" && <Failed message={page.message} action="load the protocol page" />}
        {page.status === "ready" && (
          <>
            <a href={page.data.url} target="_blank" rel="noreferrer" className="self-start text-sm text-ink underline underline-offset-2">
              Open the protocol PDF
            </a>
            <pre data-role="quote" className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap font-sans text-sm text-ink">
              {highlight(page.data.text, needle)}
            </pre>
          </>
        )}
      </aside>
    </>
  );
}

// Label column and scale column; the header, every trial row and the footer share it so the scale lines up.
const ROW = "grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-4 sm:grid-cols-[14rem_minmax(0,1fr)]";

// Dots and bars by direction: amber for a less strict limit (the one that raises a review question), ink for the
// same limit, muted for a stricter one.
const DOT: Record<string, string> = { "comparator looser": "bg-look", same: "bg-ink", "comparator stricter": "bg-uncounted" };
const BAR: Record<string, string> = { "comparator looser": "bg-look/40", "comparator stricter": "bg-uncounted/40" };

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3))));

// A condition policy (brain metastases, HIV, hepatitis B or C) has levels, not a scale: each trial's policy in words,
// with the engine's direction, and no dot plot.
function PolicyCompare({ rows, target, noComparators, sponsors, detailed }: {
  rows: ComparatorRow[];
  target: Criterion;
  noComparators: boolean;
  sponsors: Map<string, string>;
  detailed: boolean;
}) {
  const [open, setOpen] = useState<Stated | null>(null);
  const closeDrawer = useCallback(() => setOpen(null), []);
  const stated = rows.filter(isStated);
  const count = (d: string) => stated.filter((r) => r.direction === d).length;
  const n = stated.length;
  const caption = noComparators
    ? "No similar trial was found for this protocol."
    : n === 0
      ? "None of the similar trials states this criterion."
      : `Of ${n} similar ${n === 1 ? "trial" : "trials"} stating this policy, ${count("comparator looser")} used a less strict one, ${count("comparator stricter")} a stricter one and ${count("same")} the same; differences are questions for the team.`;
  return (
    <Frame variant={detailed ? "app" : "tour"} headline={detailed ? "Policies in similar trials" : "Compare: one rule, similar trials."} caption={caption}>
      <div data-testid="policy-compare" className="flex w-full max-w-3xl flex-col">
        <div className="pb-3">
          <p className="text-xs text-muted">this trial</p>
          <p data-testid="target-policy" className="text-lg font-semibold text-ink">
            {requirementText(target)}
          </p>
        </div>
        <ul className="flex flex-col">
          {rows.map((r) => (
            <li key={r.nct_id} className="border-t border-line">
              {isStated(r) ? (
                <button
                  type="button"
                  data-testid="comparator-policy"
                  data-nct={r.nct_id}
                  data-direction={r.direction}
                  onClick={() => setOpen(r)}
                  title="Open the protocol page this policy comes from"
                  className="flex w-full items-start gap-3 py-2 text-left transition-colors duration-150 hover:bg-line/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
                >
                  <span aria-hidden className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[r.direction] ?? "bg-uncounted"}`} />
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-ink">
                      <span className="font-medium">{r.acronym ?? r.nct_id}</span>: {requirementText(r.criterion)}
                    </span>
                    <span className="text-xs text-muted">
                      {r.direction === "same" ? "same policy (may be copied from older templates)" : (DIRECTION_TEXT[r.direction] ?? r.direction)}
                      {detailed && sponsors.get(r.nct_id) ? ` · ${sponsors.get(r.nct_id)}` : ""}
                    </span>
                  </span>
                </button>
              ) : (
                <p className="py-2 pl-5.5 text-sm text-muted">
                  <span className="font-medium text-ink">{r.acronym ?? r.nct_id}</span>: not found in its eligibility text
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>
      {open && (
        <ProtocolDrawer nct={open.nct_id} page={open.criterion.source.page} quote={open.criterion.source.text} title={open.acronym ?? open.nct_id} onClose={closeDrawer} />
      )}
    </Frame>
  );
}

// `detailed` is the app's Compare tab (sponsor and regimen lines, body-scale heading); the tour keeps the short labels.
export default function Screen2({ nct, criterionId, detailed = false }: Selection & { detailed?: boolean }) {
  const state = useApi(() => getReview(nct));
  const [open, setOpen] = useState<Stated | null>(null);
  const closeDrawer = useCallback(() => setOpen(null), []);
  if (state.status === "loading") return <Pending label="Loading the comparison…" />;
  if (state.status === "error") return <Failed message={state.message} action="load the comparison" />;
  const rows = state.data.comparison[criterionId] ?? [];
  const target = state.data.reviews.find((r) => r.criterion.id === criterionId)?.criterion;
  const sponsors = new Map(state.data.comparators.map((c) => [c.study.nct_id, c.study.sponsor]));
  if (target && isPolicy(target))
    return <PolicyCompare rows={rows} target={target} noComparators={state.data.comparators.length === 0} sponsors={sponsors} detailed={detailed} />;
  if (!target || target.value_norm === null)
    return <Failed message={`no numeric ${criterionId} limit in the review`} action="draw the comparison" engine={false} />;
  const targetValue = target.value_norm;
  const targetLimit = { operator: target.operator, value: targetValue, unit: target.unit_norm };
  // A limit on a different measure is not on this trial's scale; the engine does not compare it, so it is listed, not plotted.
  const otherMeasure = rows.filter((r): r is Stated => isStated(r) && r.direction === "different measure");
  const comparable = rows.filter((r) => r.direction !== "different measure");
  const plotted = comparable.filter(isPlotted);
  const withCriterion = comparable.filter(isStated);
  const looser = withCriterion.filter((r) => r.direction === "comparator looser").length;
  const stricter = withCriterion.filter((r) => r.direction === "comparator stricter").length;
  const same = withCriterion.filter((r) => r.direction === "same").length;
  // Operators arrive as Unicode (≥, >); a looser comparator for a floor is a lower limit.
  const floor = /[>≥]/.test(target.operator);
  const noComparators = state.data.comparators.length === 0;
  const values = [targetValue, ...plotted.map((r) => r.criterion.value_norm)];
  const pad = Math.max(0.5, (Math.max(...values) - Math.min(...values)) * 0.2);
  const lo = Math.min(...values) - pad;
  const hi = Math.max(...values) + pad;
  const pct = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const n = withCriterion.length;
  const caption = noComparators
    ? "No similar trial was found for this protocol."
    : n === 0 && otherMeasure.length > 0
      ? "The similar trials that state this criterion use a different measure; not directly comparable."
      : n === 0
        ? "None of the similar trials states this criterion."
        : `Of ${n} similar ${n === 1 ? "trial" : "trials"} stating this limit, ${looser} used a less strict one, ${stricter} a stricter one and ${same} the same; differences are questions for the team.`;
  const at = pct(targetValue);
  // Text near an edge grows inward: translating by -at% keeps the block inside the track at any width.
  const align = at < 34 ? "text-left" : at > 66 ? "text-right" : "text-center";
  const unit = target.unit_norm ?? "";
  // Axis ticks: every distinct plotted value plus this trial's, each once.
  const ticks = [...new Set(values)].sort((a, b) => a - b);

  const marker = (
    <div
      data-testid="target-marker"
      data-value={targetValue}
      className={noComparators ? "" : `absolute top-0 whitespace-nowrap ${align}`}
      style={noComparators ? undefined : { left: `${at}%`, transform: `translateX(-${at}%)` }}
    >
      <p className="text-xs text-muted">this trial</p>
      <p className="text-2xl font-semibold leading-tight tabular-nums text-ink">
        {target.operator} {fmt(targetValue)} <span className="text-sm font-normal text-muted">{unit}</span>
      </p>
    </div>
  );

  return (
    <Frame
      variant={detailed ? "app" : "tour"}
      headline={detailed ? "Limits in similar trials" : "Compare: one rule, similar trials."}
      caption={caption}
      details={
        rows.length > 0 ? (
          <ul className="list-disc pl-5">
            {rows.map((r) => (
              <li key={r.nct_id}>
                {r.acronym ?? r.nct_id}:{" "}
                {r.criterion
                  ? `${fmtLimit({ operator: r.criterion.operator, value: r.criterion.value_norm, unit: r.criterion.unit_norm })}, ${
                      r.direction === "same" ? sameText(targetLimit, { operator: r.criterion.operator, value: r.criterion.value_norm, unit: r.criterion.unit_norm }) : DIRECTION_TEXT[r.direction] ?? r.direction
                    }; ${COVERAGE_TEXT[r.coverage.status] ?? r.coverage.status}`
                  : "not stated in its protocol"}
              </li>
            ))}
          </ul>
        ) : undefined
      }
    >
      {noComparators ? (
        <div data-testid="compare-empty" className="flex max-w-2xl flex-col gap-3 rounded-lg border border-line bg-white/70 p-4">
          {marker}
          <p className="text-sm text-ink">
            No comparable trial was found for this protocol, so there is no precedent to compare this limit with. On precedent
            alone, that is <span className="font-medium">Insufficient evidence</span>; the classification comes from the other
            scoring rules.
          </p>
        </div>
      ) : (
        // One row per similar trial on a shared scale; the vertical line is this trial's limit. Rows never overlap, so the plot fits any width.
        <div className="flex w-full max-w-4xl flex-col">
          <div className={ROW}>
            <span className="self-end pb-1 text-xs font-medium text-muted">Similar trial</span>
            <div className="relative h-16">
              {marker}
              <span className="absolute bottom-0 h-2 w-0.5 -translate-x-1/2 bg-ink" style={{ left: `${at}%` }} />
            </div>
          </div>
          {plotted.length === 0 && otherMeasure.length === 0 ? (
            <p className="border-t border-line py-3 text-sm text-muted">No similar trial&apos;s limit to plot.</p>
          ) : null}
          {plotted.map((r) => {
            const v = pct(r.criterion.value_norm);
            const limit = { operator: r.criterion.operator, value: r.criterion.value_norm, unit: r.criterion.unit_norm };
            const differs = r.direction === "same" && sameKind(targetLimit, limit) !== "identical";
            return (
              <button
                key={r.nct_id}
                type="button"
                data-testid="comparator-dot"
                data-nct={r.nct_id}
                data-value={r.criterion.value_norm}
                data-direction={r.direction}
                onClick={() => setOpen(r)}
                title="Open the protocol page this limit comes from"
                className={`${ROW} border-t border-line text-left transition-colors duration-150 hover:bg-line/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink`}
              >
                <span className="flex min-w-0 flex-col py-2">
                  <span className="text-sm text-ink">
                    <span className="font-medium">{r.acronym ?? r.nct_id}</span>{" "}
                    <span className="tabular-nums text-muted">
                      {r.criterion.operator} {fmt(r.criterion.value_norm)}
                    </span>
                  </span>
                  {detailed ? (
                    <span className="flex flex-col text-xs text-muted">
                      <span data-testid="comparator-sponsor">{sponsors.get(r.nct_id)}</span>
                      {r.coverage.status === "full" ? <span>same chemo classes</span> : null}
                      {r.direction === "same" ? (
                        <span data-testid="same-note">
                          {differs ? sameText(targetLimit, limit) : "same limit (may be copied from older templates)"}
                        </span>
                      ) : null}
                    </span>
                  ) : differs ? (
                    <span className="text-xs text-muted">{sameText(targetLimit, limit)}</span>
                  ) : null}
                </span>
                <span aria-hidden className="relative self-stretch">
                  <span className="absolute inset-x-0 top-1/2 h-px bg-line" />
                  <span
                    className={`absolute top-1/2 h-1 -translate-y-1/2 rounded-full ${BAR[r.direction] ?? "bg-transparent"}`}
                    style={{ left: `${Math.min(v, at)}%`, width: `${Math.abs(v - at)}%` }}
                  />
                  <span className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-ink" style={{ left: `${at}%` }} />
                  <span
                    className={`absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-paper ${DOT[r.direction] ?? "bg-uncounted"}`}
                    style={{ left: `${v}%` }}
                  />
                </span>
              </button>
            );
          })}
          {plotted.length > 0 ? (
            <div className={`${ROW} border-t border-line pt-1`}>
              <span />
              <span className="flex flex-col gap-0.5">
                <span aria-hidden className="relative h-4 text-xs tabular-nums text-ink">
                  {ticks.map((t) => {
                    const x = pct(t);
                    return (
                      <span key={t} data-testid="axis-tick" className="absolute top-0 whitespace-nowrap" style={{ left: `${x}%`, transform: `translateX(-${x}%)` }}>
                        {fmt(t)}
                      </span>
                    );
                  })}
                </span>
                <span className="flex justify-between gap-2 text-xs text-muted">
                  <span>{floor ? "less strict" : "stricter"}</span>
                  <span>{unit}</span>
                  <span>{floor ? "stricter" : "less strict"}</span>
                </span>
              </span>
            </div>
          ) : null}
          {plotted.length > 0 ? (
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-look" /> less strict
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-ink" /> same
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="h-2.5 w-2.5 rounded-full bg-uncounted" /> stricter
              </span>
            </p>
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
                      className="text-left text-ink underline decoration-uncounted underline-offset-2 transition-colors duration-150 hover:decoration-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
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
      )}
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
