// Typed client for the ProtocolOS FastAPI engine. Requests go to /api/*, which next.config rewrites to PROTOCOLOS_API_URL.
// Every request carries the visitor session id; the visitor's own model key is sent only when a call asks for it.

import { keyHeaders, sessionId, type ModelKey } from "./visitor";

// Defaults for the guided tour (EL3, hemoglobin).
export const NCT = "NCT03409614";
export const CRITERION = "hemoglobin";

// The preloaded trials: their reviews are cached on the server, so they open without a key. Any other trial is
// analysed on request with the visitor's own OpenAI or Anthropic key (trialforge/access.py).
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
  // Protocol PDFs posted on ClinicalTrials.gov; empty when the criteria could come only from the registry text.
  protocol_docs?: unknown[];
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
  computed_at?: string;
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

// A failed call keeps its status (0 when the engine did not answer at all) so a screen can say what went wrong; `code` is
// the engine's machine-readable reason when it gives one (key_required, key_invalid, rate_limited, daily_limit, ...).
export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null = null,
    readonly detail: string | null = null,
  ) {
    super(message);
  }
}

// Codes that the visitor can fix by entering (another) model key.
const KEY_CODES = new Set(["key_required", "key_invalid", "key_malformed", "model_unavailable"]);
export const needsKey = (err: unknown) => err instanceof EngineError && err.code !== null && KEY_CODES.has(err.code);

type Init = RequestInit & { withKey?: boolean | ModelKey };

async function request<T>(path: string, init?: Init): Promise<T> {
  const { withKey, ...rest } = init ?? {};
  const key = withKey ? keyHeaders(withKey === true ? undefined : withKey) : {};
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      headers: { "content-type": "application/json", "X-ProtocolOS-Session": sessionId(), ...key, ...rest.headers },
    });
  } catch (err: unknown) {
    throw new EngineError(`${rest.method ?? "GET"} ${path} got no answer (${err instanceof Error ? err.message : String(err)})`, 0);
  }
  if (!res.ok) {
    let code: string | null = null;
    let detail: string | null = null;
    try {
      const body = (await res.json()) as { code?: unknown; detail?: unknown };
      code = typeof body.code === "string" ? body.code : null;
      detail = typeof body.detail === "string" ? body.detail : null;
    } catch {
      // not JSON: the status is all there is
    }
    throw new EngineError(`${rest.method ?? "GET"} ${path} returned ${res.status}${detail ? `: ${detail}` : ""}`, res.status, code, detail);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body: unknown, withKey?: boolean) =>
  request<T>(path, { method: "POST", body: JSON.stringify(body), withKey });

// Several views read the same review; fetch each trial's once per page load. `withKey` sends the visitor's key, which
// the engine needs only to analyse a trial that is not cached yet.
const reviews = new Map<string, Promise<Review>>();
export function getReview(nct: string, withKey = false): Promise<Review> {
  const cached = reviews.get(nct);
  if (cached) return cached;
  const pending = request<Review>(`/api/review/${encodeURIComponent(nct)}`, { withKey }).catch((err: unknown) => {
    reviews.delete(nct);
    throw err;
  });
  reviews.set(nct, pending);
  return pending;
}

export const getGraph = (nct: string, criterionId: string) =>
  request<Graph>(`/api/graph/${encodeURIComponent(nct)}?criterion_id=${encodeURIComponent(criterionId)}`);

export type AskMode = "deterministic" | "model";
export const investigate = (nct: string, criterionId: string, question: Question, mode: AskMode = "deterministic") =>
  post<Investigation>("/api/investigate", { nct, criterion_id: criterionId, question, mode }, mode === "model");

// Checks a key with the provider's free models lookup; the engine stores nothing but a hash, for a few minutes.
export const checkModelKey = (k: ModelKey) =>
  request<{ ok: true; provider: string; model: string; label: string }>("/api/model/check", { method: "POST", withKey: k });

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
// A plain link cannot send headers, so the export link names the session in the query.
export const packetExportUrl = (nct: string) => `/api/packet/${encodeURIComponent(nct)}?format=md&session=${sessionId()}`;

// For requests the public deploy is meant to refuse: the status code is the result, so a 4xx/5xx is not an error here.
export async function probeStatus(path: string, init?: RequestInit): Promise<number> {
  const res = await fetch(path, init);
  return res.status;
}
