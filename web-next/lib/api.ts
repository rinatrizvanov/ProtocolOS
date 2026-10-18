// Typed client for the ProtocolOS FastAPI engine. Requests go to /api/*, which next.config rewrites to PROTOCOLOS_API_URL.

// Defaults for the guided tour (EL3, hemoglobin).
export const NCT = "NCT03409614";
export const CRITERION = "hemoglobin";

// Trials with a cached review. Public mode refuses a recompute, so the app offers only these.
export const CACHED_TRIALS = ["NCT03409614", "NCT02578680", "NCT03088540", "NCT02819518"] as const;

export const QUESTIONS = {
  why_flagged: "Why was it flagged?",
  contradicting: "What contradicts it?",
  support_retaining: "What supports keeping it?",
  what_would_change: "What would change it?",
} as const;
export type Question = keyof typeof QUESTIONS;

// The investigator reads "it" as the classification (trialforge/investigate.primary_polarity): for a criterion that is not
// "Evidence supports retaining", "contradicting" returns the same sources as "support_retaining". Labels follow that.
export function questionLabel(q: Question, classification: Classification | null): string {
  if (q === "why_flagged" && classification && classification !== "Review recommended") return "Why this classification?";
  if (q === "contradicting" && classification === "Review recommended") return "What argues against the flag?";
  if (q === "contradicting" && classification === "Insufficient evidence") return "What argues against this classification?";
  return QUESTIONS[q];
}

// True when the engine answers this question from the same sources as "What supports keeping it?".
export const sameAsSupport = (q: Question, classification: Classification | null) =>
  q === "contradicting" && classification !== null && classification !== "Evidence supports retaining";

export interface Selection {
  nct: string;
  criterionId: string;
}

export type Classification = "Review recommended" | "Evidence supports retaining" | "Insufficient evidence";
export type Direction = "comparator looser" | "same" | "comparator stricter" | "different measure" | "not found";
export type DecisionKey = "accept" | "reject" | "needs_medical_review" | "defer";

export interface Study {
  nct_id: string;
  title: string;
  acronym: string | null;
  sponsor: string;
  start_date: string;
  status?: string | null;
  phases?: string[];
  registry_url?: string;
  enrollment: { count: number; type: string };
}

export interface Criterion {
  id: string;
  label: string;
  operator: string;
  value_norm: number | null;
  unit_norm: string | null;
  // Where the extractor read the criterion: the protocol's own wording (data, never instructions).
  source?: { doc?: string; url?: string; page: number | null; text: string };
}

export interface CriterionReview {
  criterion: Criterion;
  classification: Classification;
  scores: { support: number; challenge: number };
  evidence: { kind: string; stance: string; summary: string }[];
  missing_evidence: string[];
}

export interface SourceRef {
  page: number;
  text: string;
  url: string;
}

export interface ComparatorRow {
  nct_id: string;
  acronym: string | null;
  direction: Direction;
  coverage: { status: string };
  criterion: { label: string; operator: string; value_norm: number | null; unit_norm: string | null; source: SourceRef } | null;
}

export interface Review {
  target: { study: Study };
  comparators: { study: Study }[];
  reviews: CriterionReview[];
  comparison: Record<string, ComparatorRow[]>;
}

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  epistemic?: string;
  source?: { nct: string | null; page: number | null; quote: string; url: string };
  data: { retrospective?: boolean; issued?: string; citation?: string; [key: string]: unknown };
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: string;
  stance?: string;
  points?: number;
  axis?: "support" | "challenge";
  group?: string;
  scope?: string | null;
  label?: string;
}

export interface Graph {
  nct_id: string;
  criterion_id: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  warnings: string[];
}

export interface Statement {
  id: string;
  text: string;
  status: string;
  polarity: string;
  evidence_ids: string[];
  failed_checks: string[];
}

export interface Check {
  check: string;
  result: string;
  detail: string;
  statement_id?: string;
  category?: string;
}

export interface Investigation {
  classification: string;
  mode: string;
  answer: { summary: string; overall: string; statements: Statement[] };
  counterevidence: string[];
  checks: Check[];
  budget: { used: number; max_tool_calls: number; used_model: number; max_model_calls: number; max_seconds: number };
  elapsed_s: number;
  model: { status: string; provider: string | null };
}

export interface Verification {
  deterministic: { status: string; outcome: string; checks: Check[] };
}

type Fraction = [number, number];

export interface Planted {
  label: string;
  summary: {
    stricter: { n: number; escalated_strict: Fraction };
    looser: { n: number; false_over_restriction_flags: Fraction };
  };
}

export interface Evals {
  suites: { extraction: { gold_criteria: number; found_correct: number; field_accuracy: number; protocols: number } };
}

export interface ProtocolPage {
  nct: string;
  page: number;
  text: string;
  url: string;
}

export interface DecisionRecord {
  decision: DecisionKey;
  label: string;
  reason: string;
  reviewer: string;
  recorded_at: string;
}

export interface Packet {
  items: { criterion_id: string; requirement: { label: string; threshold: string }; decision: DecisionRecord | null }[];
  decision_summary: Record<DecisionKey, number>;
}

// A failed call keeps its status (0 when the engine did not answer at all) so a screen can say what went wrong.
export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  } catch (err: unknown) {
    throw new EngineError(`${init?.method ?? "GET"} ${path} got no answer (${err instanceof Error ? err.message : String(err)})`, 0);
  }
  if (!res.ok) throw new EngineError(`${init?.method ?? "GET"} ${path} returned ${res.status}`, res.status);
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

// Several views read the same review; fetch each trial's once per page load.
const reviews = new Map<string, Promise<Review>>();
export function getReview(nct: string): Promise<Review> {
  const cached = reviews.get(nct);
  if (cached) return cached;
  const pending = request<Review>(`/api/review/${encodeURIComponent(nct)}`).catch((err: unknown) => {
    reviews.delete(nct);
    throw err;
  });
  reviews.set(nct, pending);
  return pending;
}

export const getGraph = (nct: string, criterionId: string) =>
  request<Graph>(`/api/graph/${encodeURIComponent(nct)}?criterion_id=${encodeURIComponent(criterionId)}`);

export const investigate = (nct: string, criterionId: string, question: Question) =>
  post<Investigation>("/api/investigate", { nct, criterion_id: criterionId, question });

// The reviewer's deliberately wrong argument on screen 5, shown word for word; the unit comes from the ANC criterion.
export const ANC_CLAIM_TEXT = "Cemiplimab is a PD-1 inhibitor and is not myelosuppressive, so the ANC floor can be lowered.";
export const verifyAncClaim = (nct: string, proposedUnit: string) =>
  post<Verification>("/api/verify", {
    nct,
    recommendation: {
      criterion_id: "anc",
      action: "relax",
      proposed_value: 1.0,
      proposed_unit: proposedUnit,
      text: ANC_CLAIM_TEXT,
      claims: [
        { type: "drug_property", drug: "cemiplimab", property: "myelosuppressive", value: false },
        {
          type: "fda_quote",
          guidance: "lab",
          quote: "Laboratory value-based eligibility criteria should be customized to the drug(s) under investigation.",
        },
      ],
    },
  });

// A reviewer's suggestion as /api/verify accepts it; every claim is checked against a source.
export type Claim =
  | { type: "comparator_threshold"; nct_id: string; value: number; unit: string }
  | { type: "fda_quote"; guidance: string; quote: string }
  | { type: "drug_property"; drug: string; property: string; value: boolean };

export interface Recommendation {
  criterion_id: string;
  action: string;
  proposed_value: number | null;
  proposed_unit: string;
  text: string;
  claims: Claim[];
}

export const verifyRecommendation = (nct: string, recommendation: Recommendation) =>
  post<Verification>("/api/verify", { nct, recommendation });

// NHANES share of US adults below a "≥" limit (trialforge/nhanes.below_threshold); a general-population measure.
export interface PopulationBelow {
  threshold: number;
  unit: string;
  overall: { n: number; pct: number; se: number };
  source: { dataset: string; url: string };
  caveat: string;
}

export interface WhatIf {
  alternative: number;
  comparators: { nct_id: string; acronym: string | null; threshold: number; relation_to_alternative: string }[];
  // Built by the engine from the comparators that used exactly the proposed limit.
  auto_recommendation: Recommendation;
  verification: Verification["deterministic"];
  population: { current: PopulationBelow; alternative: PopulationBelow } | null;
}

export const whatIf = (nct: string, criterionId: string, value: number) =>
  post<WhatIf>("/api/whatif", { nct, criterion_id: criterionId, value });

export const getPlanted = () => request<Planted>("/api/planted");
export const getEvals = () => request<Evals>("/api/evals");
export const getProtocolPage = (nct: string, page: number) =>
  request<ProtocolPage>(`/api/protocol/${encodeURIComponent(nct)}/page/${page}`);

export const saveDecision = (nct: string, criterionId: string, decision: DecisionKey, reason: string, reviewer: string) =>
  post<Record<string, DecisionRecord>>("/api/decision", { nct, criterion_id: criterionId, decision, reason, reviewer });

export const getPacket = (nct: string) => request<Packet>(`/api/packet/${encodeURIComponent(nct)}`);

// For requests the public deploy is meant to refuse: the status code is the result, so a 4xx/5xx is not an error here.
export async function probeStatus(path: string, init?: RequestInit): Promise<number> {
  const res = await fetch(path, init);
  return res.status;
}
