import type { RationaleCategory } from "@/lib/contracts";

// P0 stub with frozen props (plan-v2 section 6.3); WS-B replaces the markup and adds icons.
export function RationaleBadges({ categories, size = "md" }: { categories: RationaleCategory[]; size?: "sm" | "md" }) {
  return (
    <ul className="flex flex-wrap gap-2" data-size={size}>
      {categories.map((c) => (
        <li key={c.key} data-testid="rationale-badge" data-key={c.key} title={c.basis}>
          {c.label}
          {c.status === "inferred" ? " (inferred)" : null}
        </li>
      ))}
    </ul>
  );
}
