// P0 stub with frozen props (plan-v2 section 6.3); WS-E replaces it with the list from /api/rationale.
export function MissingCriteria({ nct }: { nct: string }) {
  return <div data-testid="missing-none" data-nct={nct} hidden />;
}
