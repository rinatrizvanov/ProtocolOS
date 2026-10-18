// P0 stub with frozen props (plan-v2 section 6.3); WS-B replaces the markup.
export function AppHeader({ mode }: { mode: "home" | "review" | "draft" | "tour" }) {
  return (
    <header data-mode={mode} className="flex items-center gap-4 border-b border-line px-4 py-2 text-sm">
      <a href="./" className="font-semibold text-ink">
        ProtocolOS
      </a>
      <a data-testid="nav-review" href="review">
        Finishing a trial
      </a>
      <a data-testid="nav-draft" href="draft">
        Create criteria from an idea
      </a>
      <a data-testid="nav-tour" href="tour">
        Guided tour
      </a>
    </header>
  );
}
