"use client";

import { useEffect, useState } from "react";
import { getGraph, type Graph } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Failed, Frame, Pending } from "../components/Frame";

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

export default function Screen3() {
  const state = useApi(getGraph);
  if (state.status === "loading") return <Pending label="Loading the evidence graph…" />;
  if (state.status === "error") return <Failed message={state.message} />;
  const graph = state.data;
  const against = sumAxis(graph, "challenge");
  const support = sumAxis(graph, "support");
  const passages = graph.nodes.filter((n) => n.type === "GuidancePassage");
  const scoreEdges = graph.edges.filter((e) => e.type === "RULE_SCORES");

  return (
    <Frame
      headline="Why it was flagged."
      caption={`Points against the rule: ${against}; for it: ${support}. FDA passages issued after the trial started are retrospective and not counted.`}
      details={
        <>
          <ul className="list-disc pl-5">
            {scoreEdges.map((e) => (
              <li key={e.id}>
                {e.label ?? e.id} ({e.axis}, <span className="tabular-nums">{e.points ?? 0}</span>)
              </li>
            ))}
          </ul>
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
            <p className="text-sm text-muted">Similar trials used a lower limit</p>
          </div>
          <div data-testid="pan-for" data-points={support} className="text-right">
            <p className="text-6xl font-semibold tabular-nums text-ink">+{support}</p>
            <p className="text-base text-ink">For the rule</p>
            <p className="text-sm text-muted">The chemotherapy needs some limit, not this one</p>
          </div>
        </div>
        <div data-testid="parked" data-count={passages.length} className="w-full max-w-2xl rounded-lg bg-uncounted-soft p-4 text-muted">
          <span className="text-3xl tabular-nums">0</span> points: {passages.length} FDA passages, retrospective: issued after the trial started
        </div>
      </div>
    </Frame>
  );
}
