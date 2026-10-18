"use client";

import { useEffect, useState } from "react";
import { getGraph, getReview, type Classification, type CriterionReview, type Graph, type Selection } from "@/lib/api";
import { DISPLAY_CLASSIFICATION, getRationale, type ArmAttribution, type RationaleCategory } from "@/lib/contracts";
import { EvidenceColumns } from "../screens/EvidenceColumns";
import { Failed, Pending } from "./Frame";
import { EyeOffIcon, PeopleIcon } from "./Icons";
import { RationaleBadges } from "./RationaleBadges";

export const BLIND_SPOT =
  "Rationale in non-public sources (preclinical toxicology, internal development data, regulator correspondence) cannot be seen by ProtocolOS.";

const TONE: Record<Classification, string> = {
  "Review recommended": "border-look bg-look-soft",
  "Evidence supports retaining": "border-support bg-support-soft",
  "Insufficient evidence": "border-uncounted bg-uncounted-soft",
};

// Plain-language reading of each scoring rule group (graph RULE_SCORES edges); unknown groups show the edge label.
const GROUP_TEXT: Record<string, string> = {
  looser_comparators: "Similar trials used a less strict limit",
  same_comparators: "Two or more similar trials used the same limit, none less strict",
  stricter_comparators: "A similar trial used a stricter limit",
  regimen_support: "The regimen's known toxicity supports having a limit, not this value",
  specific_fda: "FDA guidance specific to this criterion",
};

type Loaded<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };
type RationaleRow = { categories: RationaleCategory[]; arm_attribution: ArmAttribution } | null;

function useLoad<T>(fetcher: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  useEffect(() => {
    let live = true;
    fetcher().then(
      (data) => live && setState({ status: "ready", data }),
      (err: unknown) => live && setState({ status: "error", message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function threshold(row: CriterionReview): string {
  const c = row.criterion;
  return c.value_norm === null ? "no numeric limit" : `${c.operator} ${c.value_norm}${c.unit_norm ? ` ${c.unit_norm}` : ""}`;
}

// Rationale tab (merges the old Why view): category badges, arm attribution, the scoring rules, the blind spot.
export function RationalePanel({ nct, criterionId }: Selection) {
  const review = useLoad(() => getReview(nct), [nct]);
  const graph = useLoad<Graph>(() => getGraph(nct, criterionId), [nct, criterionId]);
  // Fetched in parallel with the review; a failure hides badges and the arm line and implies no finding.
  const rationale = useLoad<RationaleRow>(
    () => getRationale(nct).then((r) => r.criteria[criterionId] ?? null),
    [nct, criterionId],
  );

  if (review.status === "loading") return <Pending label="Loading the rationale…" />;
  if (review.status === "error") return <Failed message={review.message} />;
  const row = review.data.reviews.find((r) => r.criterion.id === criterionId);
  if (!row) return <Failed message={`criterion ${criterionId} is not in this review`} />;
  const extra = row as CriterionReview & { explanation?: string; suggested_action?: { action: string; text: string } };
  const rat = rationale.status === "ready" ? rationale.data : null;

  const edges = graph.status === "ready" ? graph.data.edges.filter((e) => e.type === "RULE_SCORES") : [];
  const passages = graph.status === "ready" ? graph.data.nodes.filter((n) => n.type === "GuidancePassage") : [];
  const fdaScored = edges.some((e) => e.group === "specific_fda");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 data-role="headline" className="text-2xl font-semibold tracking-tight text-ink">
          {row.criterion.label} <span className="tabular-nums text-muted">{threshold(row)}</span>
        </h2>
        <p data-role="caption" className="text-sm text-muted">
          Why this criterion exists, which arm drives it, and how ProtocolOS scored it. The team decides.
        </p>
      </div>

      <div
        data-testid="classification"
        data-classification={row.classification}
        className={`flex flex-col gap-2 rounded-lg border-l-4 px-4 py-3 ${TONE[row.classification]}`}
      >
        <p className="text-base font-semibold text-ink">{DISPLAY_CLASSIFICATION[row.classification]}</p>
        {rat && rat.categories.length > 0 ? <RationaleBadges categories={rat.categories} /> : null}
        {rat ? (
          <p data-testid="arm-attribution" data-driver={rat.arm_attribution.driver} className="flex items-start gap-2 text-sm text-ink">
            <PeopleIcon className="mt-0.5 shrink-0 text-muted" />
            <span>{rat.arm_attribution.text}</span>
          </p>
        ) : null}
      </div>

      <section aria-labelledby="why-heading" className="flex flex-col gap-2">
        <h3 id="why-heading" className="text-sm font-semibold uppercase tracking-wide text-muted">
          Why ProtocolOS says this
        </h3>
        {graph.status === "loading" ? <Pending label="Loading the scoring rules…" /> : null}
        {graph.status === "error" ? <Failed message={graph.message} /> : null}
        {graph.status === "ready" ? (
          <ul data-testid="rule-scores" className="grid gap-2 sm:grid-cols-2">
            {edges.length === 0 ? <li className="text-sm text-muted">No scoring rule applied.</li> : null}
            {edges.map((e) => (
              <li
                key={e.id}
                data-axis={e.axis}
                className={`rounded-md border-l-4 bg-white/70 px-3 py-2 text-sm ${e.axis === "challenge" ? "border-look" : "border-support"}`}
              >
                <span className="font-semibold tabular-nums text-ink">
                  +{e.points ?? 0} {e.axis === "challenge" ? "against" : "for"}
                </span>{" "}
                <span className="text-ink">{GROUP_TEXT[e.group ?? ""] ?? e.label}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <p data-testid="fda-note" className="text-sm text-muted">
          {fdaScored
            ? "FDA guidance specific to this criterion counted in the score."
            : `${passages.length} FDA passage${passages.length === 1 ? "" : "s"}, 0 points: the passages are general guidance, not specific to this criterion, so they are shown as context only.`}{" "}
          FDA guidance issued after the trial started is labelled retrospective; the date alone does not change the score.
        </p>
        {extra.explanation ? (
          <figure className="rounded-md border border-line bg-white/60 px-3 py-2">
            <figcaption className="text-xs font-medium text-muted">Engine output, verbatim</figcaption>
            <blockquote data-role="quote" className="mt-1 text-sm text-ink">
              {extra.explanation}
            </blockquote>
          </figure>
        ) : null}
      </section>

      {row.missing_evidence.length > 0 || extra.suggested_action ? (
        <section aria-labelledby="open-heading" className="flex flex-col gap-2">
          <h3 id="open-heading" className="text-sm font-semibold uppercase tracking-wide text-muted">
            Open questions for the team
          </h3>
          <ul data-role="quote" className="list-disc space-y-1 pl-5 text-sm text-ink">
            {row.missing_evidence.map((m) => (
              <li key={m}>{m}</li>
            ))}
            {extra.suggested_action ? <li>{extra.suggested_action.text}</li> : null}
          </ul>
        </section>
      ) : null}

      {graph.status === "ready" ? (
        <details className="text-sm text-muted">
          <summary className="cursor-pointer select-none py-1 text-ink">Sources by score</summary>
          <div className="mt-2">
            <EvidenceColumns graph={graph.data} />
          </div>
        </details>
      ) : null}

      <footer data-testid="blind-spot" className="flex items-start gap-2 border-t border-line pt-3 text-xs text-muted">
        <EyeOffIcon className="mt-0.5 shrink-0" />
        {BLIND_SPOT}
      </footer>
    </div>
  );
}
