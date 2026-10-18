// Types and the request for POST /api/redraft: the engine checks a redrafted criterion against the protocol text,
// similar trials, FDA guidance, NHANES and the verifier, and returns flags ordered fail, warn, info, pass.

export type FlagLevel = "fail" | "warn" | "info" | "pass";

export interface RedraftSource {
  label: string;
  url: string | null;
  page: number | null;
}

export interface RedraftFlag {
  level: FlagLevel;
  code: string;
  message: string;
  source: RedraftSource | null;
}

export interface RedraftLimit {
  operator: string;
  value: number | null;
  unit: string | null;
  conditions: string[];
  text: string;
}

export interface RedraftOriginal extends RedraftLimit {
  page: number | null;
  url: string | null;
}

export interface RedraftPrecedent {
  nct_id: string;
  acronym: string | null;
  value: number | null;
  unit: string | null;
  relation: "same as draft" | "stricter than draft" | "more permissive than draft" | string;
}

export interface RedraftResult {
  criterion_id: string;
  label: string;
  original: RedraftOriginal;
  parsed: RedraftLimit | null;
  changed: { operator: boolean; value: boolean; unit: boolean; conditions_dropped: string[] };
  flags: RedraftFlag[];
  precedents: { total: number; same: number; stricter: number; looser: number; values: RedraftPrecedent[] };
  verification: {
    status: "PASSED" | "PASSED_WITH_WARNINGS" | "REJECTED";
    outcome: string;
    checks: { check: string; result: string; detail: string }[];
  } | null;
  population: { current_pct: number; proposed_pct: number; rule: string; caveat: string } | null;
  summary: Record<FlagLevel, number>;
}

export interface RedraftRequest {
  nct: string;
  criterion_id: string;
  text: string;
  rationale: string;
  as_of?: string;
}

export async function redraft(body: RedraftRequest, signal?: AbortSignal): Promise<RedraftResult> {
  const res = await fetch("/api/redraft", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ as_of: "auto", ...body }),
    signal,
  });
  if (!res.ok) {
    let detail = "";
    try {
      const data = (await res.json()) as { detail?: unknown };
      detail = typeof data.detail === "string" ? data.detail : "";
    } catch {
      // The body was not JSON; the status code is enough.
    }
    throw new Error(`The check returned ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()) as RedraftResult;
}
