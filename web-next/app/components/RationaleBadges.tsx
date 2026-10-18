import type { CategoryKey, RationaleCategory } from "@/lib/contracts";
import { LayersIcon, ShieldIcon, TargetIcon } from "./Icons";

const STYLE: Record<CategoryKey, { Icon: typeof ShieldIcon; tone: string }> = {
  safety: { Icon: ShieldIcon, tone: "border-safety/40 bg-safety-soft text-safety" },
  enrichment: { Icon: TargetIcon, tone: "border-enrich/40 bg-enrich-soft text-enrich" },
  precedent: { Icon: LayersIcon, tone: "border-precedent/40 bg-precedent-soft text-precedent" },
};

// One badge per rationale category: icon, label, and "inferred" when the protocol does not state it.
// `explained` (the review's Rationale tab) drops the per-badge word: one line says which categories are inferred, and
// each basis is readable in a disclosure, not only in a hover title that touch and keyboard users cannot open.
export function RationaleBadges({
  categories,
  size = "md",
  explained = false,
}: {
  categories: RationaleCategory[];
  size?: "sm" | "md";
  explained?: boolean;
}) {
  const pad = size === "sm" ? "px-1.5 py-0.5 text-xs gap-1" : "px-2.5 py-1 text-sm gap-1.5";
  const inferred = categories.filter((c) => c.status === "inferred");
  const list = (
    <ul className="flex flex-wrap gap-2" data-size={size} aria-label="Rationale categories">
      {categories.map((c) => {
        const { Icon, tone } = STYLE[c.key] ?? STYLE.precedent;
        return (
          <li
            key={c.key}
            data-testid="rationale-badge"
            data-key={c.key}
            data-status={c.status}
            title={c.basis}
            className={`inline-flex items-center rounded-full border font-medium ${pad} ${tone}`}
          >
            <Icon />
            <span>{c.label}</span>
            {!explained && c.status === "inferred" ? <span className="font-normal">inferred</span> : null}
            {explained && c.status !== "inferred" ? <span className="font-normal">stated in protocol</span> : null}
          </li>
        );
      })}
    </ul>
  );
  if (!explained) return list;
  return (
    <div className="flex flex-col gap-1.5">
      {list}
      <p className="text-xs text-muted">
        {inferred.length === categories.length
          ? "Categories inferred from the criterion type and regimen; the protocol does not state them."
          : inferred.length > 0
            ? `${inferred.map((c) => c.label).join(", ")}: inferred from the criterion type and regimen; the protocol does not state ${inferred.length === 1 ? "it" : "them"}.`
            : "Categories stated in the protocol."}
      </p>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer select-none py-0.5 text-ink">Why these categories</summary>
        <dl data-testid="category-basis" className="mt-1 flex flex-col gap-1">
          {categories.map((c) => (
            <div key={c.key}>
              <dt className="inline font-medium text-ink">{c.label}: </dt>
              <dd className="inline">{c.basis}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
