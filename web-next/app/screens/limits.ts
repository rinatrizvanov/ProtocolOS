// Wording for a comparator's limit next to this trial's, shared by Compare and the Sources cards.

export type Limit = { operator: string; value: number | null; unit: string | null };

const num = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3))));

export function fmtLimit(l: Limit): string {
  if (l.value === null) return l.operator || "no numeric limit";
  return `${l.operator} ${num(l.value)}${l.unit ? ` ${l.unit}` : ""}`;
}

// The engine counts a washout within 10% of this trial's as "same" (trialforge/comparators.SIMILAR_TOLERANCE), and a
// lab value with another operator (> vs ≥) as "same" too. Say which, so "same" never hides a different limit.
export function sameKind(target: Limit, comp: Limit): "identical" | "operator" | "within" {
  if (comp.value !== null && target.value !== null && comp.value !== target.value) return "within";
  if (comp.operator !== target.operator) return "operator";
  return "identical";
}

export function sameText(target: Limit, comp: Limit): string {
  const kind = sameKind(target, comp);
  if (kind === "within") {
    const unit = target.unit ? ` ${target.unit}` : "";
    return `counted as the same limit (within 10%: ${num(comp.value as number)} vs ${num(target.value as number)}${unit})`;
  }
  if (kind === "operator") return `same value, different operator (${fmtLimit(comp)} vs ${fmtLimit(target)})`;
  return "same limit";
}

export const DIRECTION_TEXT: Record<string, string> = {
  "comparator looser": "less strict",
  "comparator stricter": "stricter",
  same: "same limit",
  "different measure": "different measure",
  "not found": "not stated",
};

export const COVERAGE_TEXT: Record<string, string> = {
  full: "same chemotherapy classes",
  partial: "some chemotherapy classes differ",
  none: "no shared chemotherapy class",
  "n/a": "regimen match not needed for this criterion",
};
