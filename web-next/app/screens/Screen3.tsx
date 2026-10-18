"use client";

import { useEffect, useState } from "react";
import { getGraph, getReview, type CriterionReview, type Graph, type Selection } from "@/lib/api";

// Plain-language reading of each scoring rule group; anything else falls back to the edge's own label.
const GROUP_TEXT: Record<string, string> = {
  looser_comparators: "Similar trials used a less strict limit",
  regimen_support: "The regimen supports having some limit; it does not justify this value",
};

function axisText(graph: Graph, axis: "support" | "challenge", overrides: Record<string, string> = {}): string {
  const edges = graph.edges.filter((e) => e.type === "RULE_SCORES" && e.axis === axis);
  if (edges.length === 0) return "No scoring rule applied";
  return edges.map((e) => overrides[e.group ?? ""] ?? GROUP_TEXT[e.group ?? ""] ?? e.label ?? e.group ?? "").join("; ");
}
import { useApi } from "@/lib/useApi";
import { Failed, Frame, Pending } from "../components/Frame";
import { EvidenceColumns } from "./EvidenceColumns";

const MAX_TILT_DEG = 14;

function sumAxis(graph: Graph, axis: "support" | "challenge"): number {
  return graph.edges
    .filter((e) => e.type === "RULE_SCORES" && e.axis === axis)
    .reduce((total, e) => total + (e.points ?? 0), 0);
}

function Balance({ against, support }: { against: number; support: number }) {
  // Start level, then tilt after mount so the 200 ms transition shows the weighing.
  const [tilted, setTilted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setTilted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  // Positive difference drops the left (against) pan.
  const angle = Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, (against - support) * 5));
  const rotation = tilted ? -angle : 0;
  return (
    <svg viewBox="0 0 600 260" className="w-full max-w-2xl" role="img" aria-label={`Against ${against}, for ${support}`}>
      <polygon points="300,120 270,240 330,240" className="fill-uncounted" />
      <g style={{ transform: `rotate(${rotation}deg)`, transformOrigin: "300px 120px", transition: "transform 200ms ease-out" }}>
        <line x1="80" y1="120" x2="520" y2="120" strokeWidth="6" className="stroke-ink" />
        <g style={{ transform: `rotate(${-rotation}deg)`, transformOrigin: "80px 120px", transition: "transform 200ms ease-out" }}>
          <line x1="80" y1="120" x2="80" y2="170" strokeWidth="2" className="stroke-muted" />
          <rect x="20" y="170" width="120" height="14" rx="3" className="fill-look" />
        </g>
        <g style={{ transform: `rotate(${-rotation}deg)`, transformOrigin: "520px 120px", transition: "transform 200ms ease-out" }}>
          <line x1="520" y1="120" x2="520" y2="170" strokeWidth="2" className="stroke-muted" />
          <rect x="460" y="170" width="120" height="14" rx="3" className="fill-support" />
        </g>
      </g>
    </svg>
  );
}

// Names the regimen drugs from the review's regimen evidence, e.g. "carboplatin, ... (myelosuppression (anemia), ...)".
function regimenSentence(row: CriterionReview | undefined): string | undefined {
  const summary = row?.evidence.find((e) => e.kind === "regimen" && e.stance === "supports")?.summary ?? "";
  const match = /^Arms include (.+?) \((.+), curated pharmacology table\)/.exec(summary);
  if (!match) return undefined;
  const effect = /\(([^()]+)\)\s*$/.exec(match[2])?.[1] ?? match[2];
  return `This chemotherapy (${match[1]}) can cause ${effect}: it justifies a limit, not this value.`;
}

// `detailed` is the app's Why tab; the tour keeps the short version.
export default function Screen3({ nct, criterionId, detailed = false }: Selection & { detailed?: boolean }) {
  const state = useApi(() => getGraph(nct, criterionId));
  const review = useApi(() => getReview(nct));
  if (state.status === "loading") return <Pending label="Loading the rationale graph…" />;
  if (state.status === "error") return <Failed message={state.message} />;
  const graph = state.data;
  const against = sumAxis(graph, "challenge");
  const support = sumAxis(graph, "support");
  const passages = graph.nodes.filter((n) => n.type === "GuidancePassage");
  const row = detailed && review.status === "ready" ? review.data.reviews.find((r) => r.criterion.id === criterionId) : undefined;
  const regimen = regimenSentence(row);

  return (
    <Frame
      headline="Why it was flagged."
      caption={`Points against the rule: ${against}; for it: ${support}. FDA passages score only when specific to the criterion; general passages count 0.`}
      details={
        <>
          <EvidenceColumns graph={graph} />
          <ul className="list-disc pl-5">
            {passages.map((p) => (
              <li key={p.id}>
                {p.data.citation ?? p.label}
                {p.data.issued ? `, issued ${p.data.issued}` : ""}
              </li>
            ))}
          </ul>
        </>
      }
    >
      <div className="flex w-full flex-col items-center gap-6">
        <Balance against={against} support={support} />
        <div className="grid w-full max-w-2xl grid-cols-2 gap-8">
          <div data-testid="pan-against" data-points={against} className="text-left">
            <p className="text-6xl font-semibold tabular-nums text-ink">+{against}</p>
            <p className="text-base text-ink">Against the rule</p>
            <p className="text-sm text-muted">{axisText(graph, "challenge")}</p>
          </div>
          <div data-testid="pan-for" data-points={support} className="text-right">
            <p className="text-6xl font-semibold tabular-nums text-ink">+{support}</p>
            <p className="text-base text-ink">For the rule</p>
            <p className="text-sm text-muted">{axisText(graph, "support", regimen ? { regimen_support: regimen } : {})}</p>
          </div>
        </div>
        <div data-testid="parked" data-count={passages.length} className="w-full max-w-2xl rounded-lg bg-uncounted-soft p-4 text-muted">
          <span className="text-3xl tabular-nums">0</span> points: {passages.length} FDA passages, general guidance, not specific to this criterion
        </div>
        {row ? (
          <div data-testid="missing-evidence" className="w-full max-w-2xl">
            <p className="text-base font-medium text-ink">Open questions</p>
            {row.missing_evidence.length ? (
              <ul data-role="quote" className="mt-1 list-disc pl-5 text-sm text-muted">
                {row.missing_evidence.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted">Nothing recorded as missing.</p>
            )}
          </div>
        ) : null}
      </div>
    </Frame>
  );
}
