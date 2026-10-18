"use client";

import { useCallback, useState } from "react";
import { getGraph, getReview, type Classification, type CriterionReview, type Selection } from "@/lib/api";
import { DISPLAY_CLASSIFICATION, getRationale, type ArmAttribution } from "@/lib/contracts";
import { useApi } from "@/lib/useApi";
import { EvidenceColumns } from "../screens/EvidenceColumns";
import { ProtocolDrawer } from "../screens/Screen2";
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
  regimen_support: "Drugs in the regimen are linked to this risk; that supports having some limit, not this specific value",
  regimen_challenge: "No drug in any arm is flagged for this toxicity in the curated pharmacology table",
  protocol_value_specific: "The protocol text references this limit's value",
  specific_fda: "FDA guidance specific to this criterion",
};

// A short, structured reading of the arm attribution; the engine's full sentence sits behind a disclosure.
function driverLine(a: ArmAttribution): string | null {
  const n = a.arms.length;
  const k = a.arms.filter((arm) => arm.has_agent).length;
  const byText = a.arms.filter((arm) => arm.matched_by === "arm text 'chemo'").length;
  switch (a.driver) {
    case "all_arms":
      if (n > 0 && byText === n) return `all ${n} arms, chemotherapy listed in each`;
      if (byText === 0) return `all ${n} arms, a linked drug named in each`;
      return `all ${n} arms (${n - byText} name a linked drug; ${byText} list chemotherapy only)`;
    case "investigational":
      return `investigational arms only (${k} of ${n})`;
    case "comparator":
      return `comparator arms only (${k} of ${n})`;
    case "mixed":
      return `some arms (${k} of ${n})`;
    case "undetermined":
      return "not determined from the registry's arm descriptions";
    default:
      return null;
  }
}

function linkedAgents(a: ArmAttribution): string[] {
  const own = a.driver === "investigational" || a.driver === "comparator" ? a.agents.filter((g) => g.arms === a.driver) : a.agents;
  return (own.length > 0 ? own : a.agents).map((g) => g.name);
}

// Rationale tab: the protocol's own wording, category badges, arm attribution, the scoring
// rules with their sources, open questions and the blind spot. The page heading above the tabs names the criterion.
// The review page keys the tab panel on trial, criterion and tab, so each selection mounts a fresh panel.
// `armTextOpen` (guided tour) opens the engine's arm sentence so the viewer reads it without a click.
export function RationalePanel({ nct, criterionId, armTextOpen = false }: Selection & { armTextOpen?: boolean }) {
  const review = useApi(() => getReview(nct));
  const graph = useApi(() => getGraph(nct, criterionId));
  // Fetched in parallel with the review; a failure hides badges and the arm line and implies no finding.
  const rationale = useApi(() => getRationale(nct).then((r) => r.criteria[criterionId] ?? null));
  const [protocolOpen, setProtocolOpen] = useState(false);
  // Sources open by default from the md breakpoint; on phones they would push the open questions far down.
  const [sourcesOpen] = useState(() => typeof window !== "undefined" && window.matchMedia("(min-width: 768px)").matches);
  const closeProtocol = useCallback(() => setProtocolOpen(false), []);

  if (review.status === "loading") return <Pending label="Loading the rationale…" />;
  if (review.status === "error") return <Failed message={review.message} action="load the rationale" />;
  const row = review.data.reviews.find((r) => r.criterion.id === criterionId);
  if (!row) return <Failed message={`criterion ${criterionId} is not in this review`} action="find this criterion" engine={false} />;
  const extra = row as CriterionReview & { explanation?: string; suggested_action?: { action: string; text: string } };
  const rat = rationale.status === "ready" ? rationale.data : null;
  const source = row.criterion.source;
  const study = review.data.target.study;

  const edges = graph.status === "ready" ? graph.data.edges.filter((e) => e.type === "RULE_SCORES") : [];
  const passages = graph.status === "ready" ? graph.data.nodes.filter((n) => n.type === "GuidancePassage") : [];
  const fdaScored = edges.some((e) => e.group === "specific_fda");
  const armApplies = rat !== null && rat.arm_attribution.driver !== "not_applicable";
  const driver = rat ? driverLine(rat.arm_attribution) : null;

  return (
    <div className="flex flex-col gap-4">
      <p data-role="caption" className="text-sm text-muted">
        {rat === null || armApplies
          ? "The likely rationale for this criterion, which arm it comes from, and how ProtocolOS scored it. The team decides."
          : "The likely rationale for this criterion and how ProtocolOS scored it. The team decides."}
      </p>

      {source?.text ? (
        <figure data-testid="protocol-wording" className="flex flex-col gap-1 rounded-md border border-line bg-white/60 px-3 py-2">
          <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs font-medium text-muted">
            <span>As written in the protocol</span>
            {source.page != null ? (
              <button
                type="button"
                data-testid="protocol-wording-page"
                onClick={() => setProtocolOpen(true)}
                className="min-h-11 text-ink underline decoration-uncounted underline-offset-2 hover:decoration-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink sm:min-h-0"
              >
                Protocol p. {source.page}
              </button>
            ) : null}
          </figcaption>
          <blockquote data-role="quote" className="text-sm text-ink">
            {source.text}
          </blockquote>
        </figure>
      ) : null}

      <div
        data-testid="classification"
        data-classification={row.classification}
        className={`flex flex-col gap-2.5 rounded-lg border-l-4 px-4 py-3 ${TONE[row.classification]}`}
      >
        <p className="text-base font-semibold text-ink">{DISPLAY_CLASSIFICATION[row.classification]}</p>
        {rat && rat.categories.length > 0 ? <RationaleBadges categories={rat.categories} explained /> : null}
        {rat ? (
          <div data-testid="arm-attribution" data-driver={rat.arm_attribution.driver} className="flex flex-col gap-1 text-sm text-ink">
            <p className="flex items-start gap-2">
              <PeopleIcon className="mt-0.5 shrink-0 text-muted" />
              {driver ? (
                <span>
                  <span className="font-medium">Driven by:</span> {driver}
                  <span className="block text-xs text-muted">
                    Linked drugs: {linkedAgents(rat.arm_attribution).join(", ")}
                    {rat.arm_attribution.property ? ` (${rat.arm_attribution.property})` : ""}
                  </span>
                </span>
              ) : (
                <span>No drug link for this criterion in the curated pharmacology table, so arm attribution does not apply.</span>
              )}
            </p>
            {driver ? (
              <details open={armTextOpen} className="pl-6 text-xs text-muted">
                <summary className="cursor-pointer select-none py-0.5 text-ink">How this was determined</summary>
                <figure className="mt-1">
                  <figcaption className="sr-only">Engine output, verbatim</figcaption>
                  <p data-role="quote" className="text-ink">
                    {rat.arm_attribution.text}
                  </p>
                </figure>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>

      <section aria-labelledby="why-heading" className="flex flex-col gap-2">
        <h3 id="why-heading" className="text-base font-semibold text-ink">
          Why ProtocolOS says this
        </h3>
        {extra.explanation ? (
          <figure className="rounded-md border border-line bg-white/60 px-3 py-2">
            <figcaption className="text-xs font-medium text-muted">Engine output, verbatim</figcaption>
            <blockquote data-role="quote" className="mt-1 text-sm text-ink">
              {extra.explanation}
            </blockquote>
          </figure>
        ) : null}
        {graph.status === "loading" ? <Pending label="Loading the scoring rules…" /> : null}
        {graph.status === "error" ? <Failed message={graph.message} action="load the scoring rules" /> : null}
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
                  +{e.points ?? 0} {e.axis === "challenge" ? "against" : "for"}:
                </span>{" "}
                <span className="text-ink">{GROUP_TEXT[e.group ?? ""] ?? e.label}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {graph.status === "ready" ? (
          <details open={sourcesOpen} data-testid="sources-by-score" className="text-sm text-muted">
            <summary className="cursor-pointer select-none py-1 font-medium text-ink">Sources by score</summary>
            <div className="mt-2">
              <EvidenceColumns graph={graph.data} />
            </div>
          </details>
        ) : null}
        {graph.status === "ready" ? (
          <p data-testid="fda-note" className="text-xs text-muted">
            {fdaScored
              ? "FDA guidance specific to this criterion counted in the score."
              : `${passages.length} FDA passage${passages.length === 1 ? "" : "s"}, 0 points: general guidance, not specific to this criterion, shown as context.`}
          </p>
        ) : null}
      </section>

      {row.missing_evidence.length > 0 || extra.suggested_action ? (
        <section aria-labelledby="open-heading" className="flex flex-col gap-2">
          <h3 id="open-heading" className="text-base font-semibold text-ink">
            Open questions for the team
          </h3>
          <figure className="rounded-md border border-line bg-white/60 px-3 py-2">
            <figcaption className="text-xs font-medium text-muted">Engine output, verbatim</figcaption>
            <ul data-role="quote" className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink">
              {row.missing_evidence.map((m) => (
                <li key={m}>{m}</li>
              ))}
              {extra.suggested_action ? <li>{extra.suggested_action.text}</li> : null}
            </ul>
          </figure>
        </section>
      ) : null}

      <footer data-testid="blind-spot" className="flex items-start gap-2 border-t border-line pt-3 text-xs text-muted">
        <EyeOffIcon className="mt-0.5 shrink-0" />
        {BLIND_SPOT}
      </footer>

      {protocolOpen && source?.page != null ? (
        <ProtocolDrawer
          nct={nct}
          page={source.page}
          quote={source.text}
          title={study.acronym ?? study.nct_id}
          onClose={closeProtocol}
        />
      ) : null}
    </div>
  );
}
