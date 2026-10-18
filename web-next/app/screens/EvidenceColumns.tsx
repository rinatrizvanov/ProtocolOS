"use client";

import { useCallback, useState } from "react";
import type { Graph, GraphNode } from "@/lib/api";
import { ProtocolDrawer } from "./Screen2";

type Stance = "challenges" | "supports" | "context";
type Source = { nct: string; page: number; quote: string };

const COLUMNS: { stance: Stance; title: string; tone: string }[] = [
  { stance: "challenges", title: "Against", tone: "border-look" },
  { stance: "supports", title: "For", tone: "border-support" },
  { stance: "context", title: "Not counted", tone: "border-uncounted" },
];

// FDA passages that feed a scoring rule score points; the rest score none and are folded into one card.
function inRule(graph: Graph, id: string): boolean {
  return graph.edges.some((e) => e.from === id && e.type === "EVIDENCE_IN_RULE");
}

function ruleOf(graph: Graph, id: string): GraphNode | undefined {
  const ruleId = graph.edges.find((e) => e.from === id && e.type === "EVIDENCE_IN_RULE")?.to;
  return graph.nodes.find((n) => n.id === ruleId);
}

// A card sits in the column its score went to: members of a scoring rule follow the rule's axis (two matching
// trials are each "context" on their own edge but score +1 together); everything else follows its edge stance.
function stanceOf(graph: Graph, node: GraphNode, edgeStance: Stance): Stance {
  const rule = ruleOf(graph, node.id);
  if (!rule || !(Number(rule.data.points) > 0)) return edgeStance;
  return rule.data.axis === "support" ? "supports" : "challenges";
}

// Evidence nodes by where they scored; score rules themselves are the column totals instead.
function evidenceByStance(graph: Graph): Record<Stance, GraphNode[]> {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const byStance: Record<Stance, GraphNode[]> = { challenges: [], supports: [], context: [] };
  const seen = new Set<string>();
  for (const e of graph.edges) {
    const node = nodes.get(e.from);
    const edgeStance = e.stance as Stance | undefined;
    if (!node || !edgeStance || !(edgeStance in byStance) || seen.has(node.id)) continue;
    if (node.type === "ScoreRule" || (node.type === "GuidancePassage" && !inRule(graph, node.id))) continue;
    seen.add(node.id);
    byStance[stanceOf(graph, node, edgeStance)].push(node);
  }
  return byStance;
}

function pointsFor(graph: Graph, stance: Stance): number {
  return graph.edges.filter((e) => e.type === "RULE_SCORES" && e.stance === stance).reduce((sum, e) => sum + (e.points ?? 0), 0);
}

type Explained = { title: string; why: string };

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function threshold(data: GraphNode["data"]): string {
  return `${text(data.operator)}${text(data.value_norm)} ${text(data.unit_norm)}`.trim();
}

// Plain language for each card: what the evidence is, then how the score used it. The rule wording mirrors
// trialforge/review.py (regimen rule, looser-comparator group, same-value matches) so the card never claims more
// than the score did.
function explain(node: GraphNode, graph: Graph): Explained {
  const target = graph.nodes.find((n) => n.type === "Criterion");
  const targetValue = target ? threshold(target.data) : "this trial's value";
  const rule = ruleOf(graph, node.id);
  const points = text(rule?.data.points);
  const members = Array.isArray(rule?.data.members) ? rule.data.members.length : 0;

  if (node.type === "ComparatorThreshold") {
    const title = `${text(node.data.acronym) || text(node.data.nct_id)} used ${threshold(node.data)}`;
    const direction = text(node.data.direction);
    if (rule?.data.group === "looser_comparators")
      return {
        title,
        why: `Less strict than this trial's ${targetValue}. The ${members} trials like this score +${points} together, once, not per trial. Used is precedent, not proof of safety.`,
      };
    if (rule?.data.group === "same_comparators")
      return {
        title,
        why: `Same value as this trial. ${members} trials match and none is less strict, so together they add +${points}, once. Matching values may still be copied from a template.`,
      };
    if (direction === "same")
      return {
        title,
        why: `Same value as this trial, so it scores nothing alone: one match may be copied from a protocol template. Matches add +1 only when two or more trials match and none is less strict.`,
      };
    if (direction === "different measure") return { title, why: "Measures this differently, so it is not directly comparable and scores nothing." };
    return { title, why: text(node.data.summary) };
  }
  if (node.type === "CuratedFact") {
    const match = /^Arms include (.+?) \((.+), curated pharmacology table\)/.exec(text(node.data.summary));
    if (match && rule?.data.group === "regimen_support")
      return {
        title: `This trial's drugs can cause ${match[2]}`,
        why: `${match[1]}, per ProtocolOS's curated drug table. So the trial needs some limit: +${points}. It does not show that ${targetValue} is the right one.`,
      };
    return { title: node.label, why: text(node.data.summary) };
  }
  if (node.type === "GuidancePassage" && rule?.data.group === "specific_fda") {
    const issued = text(node.data.issued);
    return {
      title: node.label,
      why: `A specific FDA recommendation for this kind of criterion: +${points} against.${
        node.data.retrospective === true ? ` Issued ${issued}, after this trial started, so it is applied retrospectively.` : ""
      }`,
    };
  }
  if (node.type === "Passage") {
    const page = node.source?.page;
    return node.data.value_specific === true
      ? { title: `Protocol p. ${page} references ${targetValue}`, why: "The trial's own protocol states this value." }
      : {
          title: `Protocol p. ${page} discusses this risk`,
          why: `It does not say why ${targetValue} was chosen, so it scores nothing. Open it to read the passage.`,
        };
  }
  return { title: node.label, why: text(node.data.summary) || (rule ? `Scores in: ${rule.label}` : "Shown for context; scores nothing.") };
}

function Card({ node, graph, tone, onOpen }: { node: GraphNode; graph: Graph; tone: string; onOpen: (source: Source, title: string) => void }) {
  const source = node.source;
  const { title, why } = explain(node, graph);
  const body = (
    <>
      <span className="block font-medium text-ink">{title}</span>
      <span data-testid="evidence-why" className="mt-1 block text-sm text-ink">
        {why}
      </span>
      {source?.nct ? (
        <span className="mt-2 block text-xs text-muted">
          Source: {source.nct}, p. {source.page}
        </span>
      ) : text(node.data.citation) ? (
        <span className="mt-2 block text-xs text-muted">{text(node.data.citation)}</span>
      ) : null}
    </>
  );
  const className = `block w-full rounded-md border-l-4 bg-paper px-4 py-3 text-left shadow-sm ${tone}`;
  if (source?.nct && source.page !== null && (node.type === "Passage" || node.type === "ComparatorThreshold")) {
    const target: Source = { nct: source.nct, page: source.page, quote: source.quote };
    return (
      <button
        type="button"
        data-testid="evidence-card"
        onClick={() => onOpen(target, title)}
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

// The graph's evidence in three columns, shown inside the Why view's Details.
export function EvidenceColumns({ graph }: { graph: Graph }) {
  const [open, setOpen] = useState<{ source: Source; title: string } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const columns = evidenceByStance(graph);
  const passages = graph.nodes.filter((n) => n.type === "GuidancePassage" && !inRule(graph, n.id));
  const retrospective = passages.every((n) => n.data.retrospective === true);

  return (
    <>
      <div className="grid w-full grid-cols-3 gap-4">
        {COLUMNS.map((col) => (
          <section key={col.stance} data-testid={`evidence-${col.stance}`} className="flex flex-col gap-3">
            <h2 className="text-base font-semibold text-ink">
              {col.title}
              {col.stance === "context" ? null : <span className="tabular-nums"> +{pointsFor(graph, col.stance)}</span>}
            </h2>
            {columns[col.stance].map((node) => (
              <Card key={node.id} node={node} graph={graph} tone={col.tone} onOpen={(source, title) => setOpen({ source, title })} />
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
    </>
  );
}
