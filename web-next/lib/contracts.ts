// Frozen v2 contracts (plan-v2 section 6.1): rationale, authoring mode and structured decision reasons.
// Only the main session edits this file after P0. All fetches use absolute /api/... paths.

export type EngineClassification = "Review recommended" | "Evidence supports retaining" | "Insufficient evidence";
export const DISPLAY_CLASSIFICATION: Record<EngineClassification, string> = {
  "Review recommended": "Review recommended",
  "Evidence supports retaining": "Rationale supports keeping",
  "Insufficient evidence": "Insufficient evidence",
};
export type CategoryKey = "safety" | "enrichment" | "precedent";
export interface SourceLink {
  kind: "protocol" | "comparator" | "fda" | "curated";
  label: string;
  nct_id?: string;
  page?: number;
  url?: string;
}
export interface RationaleCategory {
  key: CategoryKey;
  label: string;
  status: "inferred" | "stated in protocol";
  basis: string;
  sources: SourceLink[];
}
export type ArmDriver = "all_arms" | "investigational" | "comparator" | "mixed" | "undetermined" | "not_applicable";
export interface ArmAttribution {
  criterion_id: string;
  property: string | null;
  driver: ArmDriver;
  agents: { name: string; drug_class: string; arms: ArmDriver }[];
  arms: { label: string; type: string | null; has_agent: boolean; matched_by: "named agent" | "arm text 'chemo'" | "none" }[];
  text: string;
  method: string;
}
export interface MissingCriterion {
  criterion_id: string;
  label: string;
  comparators_with: number;
  comparators_total: number;
  examples: { nct_id: string; acronym: string | null; threshold: string; page: number | null; quote: string; url: string | null }[];
  text: string;
}
export interface RationaleReport {
  schema_version: 1;
  nct_id: string;
  criteria: Record<string, { categories: RationaleCategory[]; arm_attribution: ArmAttribution }>;
  missing: MissingCriterion[];
  blind_spot: string;
  method: string;
}
export type SettingTag = "first-line" | "metastatic" | "non-squamous" | "squamous" | "perioperative/locally-advanced";
export interface Idea {
  condition: string;
  drugs: string[];
  setting: SettingTag[];
  phase: "PHASE2" | "PHASE3";
  as_of: string | null;
}
export interface Check {
  check: string;
  result: "pass" | "warn" | "fail";
  detail: string;
  category?: string;
}
export interface Precedent {
  nct_id: string;
  acronym: string | null;
  title: string;
  sponsor: string | null;
  start_date: string | null;
  regimen: string[];
  shared_classes: string[];
  class_jaccard: number;
  tags: string[];
  protocol_url: string | null;
}
export interface PrecedentValue {
  nct_id: string;
  acronym: string | null;
  operator: string;
  value: number;
  unit: string;
  page: number | null;
  quote: string;
  url: string | null;
  coverage: "full" | "partial" | "none" | "n/a";
  eligible_for_default: boolean;
}
export interface DraftCriterion {
  id: string;
  analyte: string;
  category: "lab" | "performance_status" | "washout";
  label: string;
  section: "inclusion" | "exclusion";
  status: "drafted" | "insufficient_evidence";
  proposed: { operator: string; value: number; unit: string; text: string; source_nct_id: string } | null;
  distribution: { operator: string; value: number; unit: string; count: number; nct_ids: string[] }[];
  rationale: {
    categories: RationaleCategory[];
    precedents: PrecedentValue[];
    fda: { key: string; quote: string; citation: string; link: string; stance: string; specific: boolean }[];
    toxicity_link: { agents: string[]; property: string; text: string } | null;
    carry_forward: boolean;
  };
  verification: { status: "PASSED" | "PASSED_WITH_WARNINGS" | "REJECTED"; outcome: string; checks: Check[] } | null;
  critique: {
    classification: EngineClassification;
    explanation: string;
    scores: { support: number; challenge: number };
    missing_evidence: string[];
    suggested_action: { action: string; text: string };
  };
  why_generated: string[];
  insufficient_reason: string | null;
}
export interface Draft {
  schema_version: 1;
  draft_id: string;
  status: "ok" | "no_precedents" | "unrecognized_regimen" | "retrieval_failed";
  idea: Idea & { recognized_drugs: string[]; unrecognized_drugs: string[]; classes: string[] };
  precedents: Precedent[];
  criteria: DraftCriterion[];
  summary: {
    drafted: number;
    insufficient: number;
    precedents: number;
    candidates_checked: number;
    skipped: number;
    elapsed_s: number;
    cached: boolean;
  };
  notes: string[];
  warnings: string[];
  exports: { trialpathfinder_rules: string | null };
  computed_at: string;
}
export interface DraftPreset {
  id: string;
  title: string;
  idea: Idea;
  draft_id: string;
  cached: boolean;
}
export interface DraftVocabulary {
  drugs: { name: string; drug_class: string; aliases: string[] }[];
  settings: SettingTag[];
  phases: ("PHASE2" | "PHASE3")[];
}

export const DECISION_REASONS = [
  { key: "safety_concern", label: "Safety concern" },
  { key: "regulatory_requirement", label: "Regulatory requirement" },
  { key: "efficacy_enrichment", label: "Efficacy enrichment" },
  { key: "prior_evidence", label: "Prior evidence" },
  { key: "operational_reason", label: "Operational reason" },
  { key: "other", label: "Other" },
] as const;
export type ReasonKey = (typeof DECISION_REASONS)[number]["key"];

// The packet stores `reason` verbatim, so the structured reason is encoded in it: "Reason: <Label>." plus an optional note.
export function encodeReason(key: ReasonKey, note: string): string {
  const label = DECISION_REASONS.find((r) => r.key === key)?.label ?? "Other";
  const trimmed = note.trim();
  return `Reason: ${label}.` + (trimmed ? ` Note: ${trimmed}` : "");
}

// Legacy free text (no "Reason:" prefix) comes back as { key: null, note: reason }.
export function parseReason(reason: string): { key: ReasonKey | null; note: string } {
  const m = /^Reason: ([^.]+)\.(?: Note: ([\s\S]*))?$/.exec(reason.trim());
  if (!m) return { key: null, note: reason };
  const hit = DECISION_REASONS.find((r) => r.label === m[1]);
  if (!hit) return { key: null, note: reason };
  return { key: hit.key, note: (m[2] ?? "").trim() };
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: string | null,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init?.headers } });
  if (!res.ok) {
    let detail: string | null = null;
    try {
      const body = (await res.json()) as { detail?: unknown };
      detail = typeof body.detail === "string" ? body.detail : null;
    } catch {
      detail = null;
    }
    throw new ApiError(`${init?.method ?? "GET"} ${path} returned ${res.status}`, res.status, detail);
  }
  return (await res.json()) as T;
}

// Several views read the same rationale; fetch each trial's once per page load, like getReview.
const rationales = new Map<string, Promise<RationaleReport>>();
export function getRationale(nct: string): Promise<RationaleReport> {
  const cached = rationales.get(nct);
  if (cached) return cached;
  const pending = request<RationaleReport>(`/api/rationale/${encodeURIComponent(nct)}`).catch((err: unknown) => {
    rationales.delete(nct);
    throw err;
  });
  rationales.set(nct, pending);
  return pending;
}

export const postDraft = (idea: Idea) => request<Draft>("/api/draft", { method: "POST", body: JSON.stringify(idea) });
export const getDraft = (id: string) => request<Draft>(`/api/draft/${encodeURIComponent(id)}`);
export const getDraftPresets = () => request<DraftPreset[]>("/api/draft/presets");
export const getDraftVocabulary = () => request<DraftVocabulary>("/api/draft/vocabulary");
