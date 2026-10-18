import type { CategoryKey, RationaleCategory } from "@/lib/contracts";
import { LayersIcon, ShieldIcon, TargetIcon } from "./Icons";

const STYLE: Record<CategoryKey, { Icon: typeof ShieldIcon; tone: string }> = {
  safety: { Icon: ShieldIcon, tone: "border-safety/40 bg-safety-soft text-safety" },
  enrichment: { Icon: TargetIcon, tone: "border-enrich/40 bg-enrich-soft text-enrich" },
  precedent: { Icon: LayersIcon, tone: "border-precedent/40 bg-precedent-soft text-precedent" },
};

// One badge per rationale category: icon, label, and "inferred" when the protocol does not state it.
export function RationaleBadges({ categories, size = "md" }: { categories: RationaleCategory[]; size?: "sm" | "md" }) {
  const pad = size === "sm" ? "px-1.5 py-0.5 text-xs gap-1" : "px-2.5 py-1 text-sm gap-1.5";
  return (
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
            {c.status === "inferred" ? <span className="font-normal opacity-75">inferred</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
