// Typed client for the TrialLens FastAPI engine. Requests go to /api/*, which next.config rewrites to :8766.

export const NCT = "NCT03409614";
export const CRITERION = "hemoglobin";

export type Classification = "Review recommended" | "Evidence supports retaining" | "Insufficient evidence";
export type Direction = "comparator looser" | "same" | "comparator stricter" | "different measure" | "not found";
export type DecisionKey = "accept" | "reject" | "needs_medical_review" | "defer";

export interface Study {
  nct_id: string;
  title: string;
  acronym: string | null;
  sponsor: string;
  start_date: string;
  enrollment: { count: number; type: string };
}

export interface Criterion {
  id: string;
  label: string;
  operator: string;
  value_norm: number | null;
  unit_norm: string | null;
}

export interface CriterionReview {
  criterion: Criterion;
  classification: Classification;
  scores: { support: number; challenge: number };
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
  criterion: { operator: string; value_norm: number | null; unit_norm: string | null; source: SourceRef } | null;
}

export interface Review {
  target: { study: Study };
  reviews: CriterionReview[];
  comparison: Record<string, ComparatorRow[]>;
}

export interface GraphNode {
  id: string;
  type: string;
  label: string;
  epistemic?: string;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} returned ${res.status}`);
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

// Several screens read the same review; fetch it once per page load.
let reviewOnce: Promise<Review> | null = null;
export function getReview(): Promise<Review> {
  reviewOnce ??= request<Review>(`/api/review/${NCT}`).catch((err: unknown) => {
    reviewOnce = null;
    throw err;
  });
  return reviewOnce;
}

export const getGraph = () => request<Graph>(`/api/graph/${NCT}?criterion_id=${CRITERION}`);

export const investigate = () =>
  post<Investigation>("/api/investigate", { nct: NCT, criterion_id: CRITERION, question: "why_flagged" });

// The reviewer's deliberately wrong argument on screen 5; the unit comes from the ANC criterion in the review.
export const verifyAncClaim = (proposedUnit: string) =>
  post<Verification>("/api/verify", {
    nct: NCT,
    recommendation: {
      criterion_id: "anc",
      action: "relax",
      proposed_value: 1.0,
      proposed_unit: proposedUnit,
      text: "Cemiplimab is a PD-1 inhibitor and is not myelosuppressive, so the ANC floor can be lowered.",
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

export const getPlanted = () => request<Planted>("/api/planted");
export const getEvals = () => request<Evals>("/api/evals");
export const getProtocolPage = (nct: string, page: number) =>
  request<ProtocolPage>(`/api/protocol/${encodeURIComponent(nct)}/page/${page}`);

export const saveDecision = (decision: DecisionKey, reason: string, reviewer: string) =>
  post<Record<string, DecisionRecord>>("/api/decision", { nct: NCT, criterion_id: CRITERION, decision, reason, reviewer });

export const getPacket = () => request<Packet>(`/api/packet/${NCT}`);

// For requests the public deploy is meant to refuse: the status code is the result, so a 4xx/5xx is not an error here.
export async function probeStatus(path: string, init?: RequestInit): Promise<number> {
  const res = await fetch(path, init);
  return res.status;
}
