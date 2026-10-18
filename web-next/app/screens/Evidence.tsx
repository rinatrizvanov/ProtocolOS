"use client";

import { useCallback, useState } from "react";
import { getGraph, type Graph, type GraphNode, type Selection } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Failed, Frame, Pending } from "../components/Frame";
import { ProtocolDrawer } from "./Screen2";

type Stance = "challenges" | "supports" | "context";
type Source = NonNullable<GraphNode["source"]>;

const COLUMNS: { stance: Stance; title: string; tone: string }[] = [
  { stance: "challenges", title: "Against", tone: "border-look" },
  { stance: "supports", title: "For", tone: "border-support" },
  { stance: "context", title: "Not counted", tone: "border-uncounted" },
];

// FDA passages that feed a scoring rule score points; the rest score none and are folded into one card.
function inRule(graph: Graph, id: string): boolean {
  return graph.edges.some((e) => e.from === id && e.type === "EVIDENCE_IN_RULE");
}

// Evidence nodes by the stance of the edge that links them in; score rules are the column totals instead.
function evidenceByStance(graph: Graph): Record<Stance, GraphNode[]> {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const byStance: Record<Stance, GraphNode[]> = { challenges: [], supports: [], context: [] };
  const seen = new Set<string>();
  for (const e of graph.edges) {
    const node = nodes.get(e.from);
    const stance = e.stance as Stance | undefined;
    if (!node || !stance || !(stance in byStance) || seen.has(node.id)) continue;
    if (node.type === "ScoreRule" || (node.type === "GuidancePassage" && !inRule(graph, node.id))) continue;
    seen.add(node.id);
    byStance[stance].push(node);
  }
  return byStance;
}

function pointsFor(graph: Graph, stance: Stance): number {
  return graph.edges.filter((e) => e.type === "RULE_SCORES" && e.stance === stance).reduce((sum, e) => sum + (e.points ?? 0), 0);
}

function Card({ node, tone, onOpen }: { node: GraphNode; tone: string; onOpen: (source: Source, title: string) => void }) {
  const source = node.source;
  const body = (
    <>
      <span className="block font-medium text-ink">{node.label}</span>
      {source ? <span className="mt-1 block text-sm text-muted">{source.nct}, p. {source.page}</span> : null}
    </>
  );
  const className = `block w-full rounded-md border-l-4 bg-paper px-4 py-3 text-left shadow-sm ${tone}`;
  if (source && (node.type === "Passage" || node.type === "ComparatorThreshold")) {
    return (
      <button
        type="button"
        data-testid="evidence-card"
        onClick={() => onOpen(source, node.label)}
        className={`${className} transition-colors duration-150 hover:bg-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink`}
      >
        {body}
      </button>
    );
  }
  return (
    <div data-testid="evidence-card" className={className}>
      {body}
    </div>
  );
}

export default function Evidence({ nct, criterionId }: Selection) {
  const state = useApi(() => getGraph(nct, criterionId));
  const [open, setOpen] = useState<{ source: Source; title: string } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  if (state.status === "loading") return <Pending label="Loading the evidence graph…" />;
  if (state.status === "error") return <Failed message={state.message} />;
  const graph = state.data;
  const columns = evidenceByStance(graph);
  const passages = graph.nodes.filter((n) => n.type === "GuidancePassage" && !inRule(graph, n.id));
  const retrospective = passages.every((n) => n.data.retrospective === true);

  return (
    <Frame
      headline="Every piece of evidence, sorted."
      caption="Cards sit where the scoring put them. Click a protocol card to read its source page."
    >
      <div className="grid w-full grid-cols-3 gap-6">
        {COLUMNS.map((col) => (
          <section key={col.stance} data-testid={`evidence-${col.stance}`} className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold text-ink">
              {col.title}
              {col.stance === "context" ? null : <span className="tabular-nums"> +{pointsFor(graph, col.stance)}</span>}
            </h2>
            {columns[col.stance].map((node) => (
              <Card key={node.id} node={node} tone={col.tone} onOpen={(source, title) => setOpen({ source, title })} />
            ))}
            {col.stance === "context" && passages.length > 0 ? (
              <div data-testid="fda-card" data-count={passages.length} className={`rounded-md border-l-4 bg-paper px-4 py-3 shadow-sm ${col.tone}`}>
                <span className="block font-medium text-ink">
                  {passages.length} FDA passages, 0 points{retrospective ? ", retrospective" : ""}
                </span>
                {retrospective ? <span className="mt-1 block text-sm text-muted">Issued after the trial started.</span> : null}
              </div>
            ) : null}
          </section>
        ))}
      </div>
      {open && (
        <ProtocolDrawer nct={open.source.nct} page={open.source.page} quote={open.source.quote} title={open.title} onClose={close} />
      )}
    </Frame>
  );
}
