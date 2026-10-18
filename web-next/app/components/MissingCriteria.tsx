"use client";

import { useEffect, useState } from "react";
import { getRationale, type MissingCriterion } from "@/lib/contracts";

type State = { nct: string; status: "ready"; missing: MissingCriterion[] } | { nct: string; status: "error" };

// Criteria most comparable protocols state but this protocol's extraction lacks (plan-v2 section 6.3).
// Extraction misses are possible, so each item is a question to check in the protocol, not a finding.
export function MissingCriteria({ nct }: { nct: string }) {
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    let live = true;
    getRationale(nct).then(
      (report) => live && setState({ nct, status: "ready", missing: report.missing }),
      (err: unknown) => {
        console.error(err);
        if (live) setState({ nct, status: "error" });
      },
    );
    return () => {
      live = false;
    };
  }, [nct]);

  const current = state?.nct === nct ? state : null;
  if (!current) {
    return <p className="text-sm text-muted">Comparing with comparable protocols&hellip;</p>;
  }
  if (current.status === "error") {
    return (
      <p role="status" className="text-sm text-muted">
        Could not load the comparison
      </p>
    );
  }
  if (current.missing.length === 0) {
    return (
      <p data-testid="missing-none" className="text-sm text-muted">
        No gaps found: every criterion that most comparable protocols state was also extracted from this protocol.
      </p>
    );
  }
  return (
    <ul data-testid="missing-criteria" className="flex flex-col gap-3">
      {current.missing.map((m) => (
        <li
          key={m.criterion_id}
          data-testid="missing-item"
          data-criterion={m.criterion_id}
          className="rounded-md border border-look bg-look-soft/40 px-4 py-3"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="font-semibold text-ink">{m.label}</p>
            <p className="text-sm tabular-nums text-muted">
              in {m.comparators_with} of {m.comparators_total} comparable protocols
            </p>
          </div>
          <p className="mt-1 text-sm text-ink">{m.text}</p>
          {m.examples.length > 0 ? (
            <ul className="mt-2 flex flex-col gap-1 text-sm text-muted">
              {m.examples.map((e) => {
                const name = e.acronym ?? e.nct_id;
                const where = e.page != null ? `p. ${e.page}` : "protocol";
                return (
                  <li key={e.nct_id} title={e.quote || undefined}>
                    <span className="text-ink">{name}</span>: {e.threshold}
                    {" ("}
                    {e.url ? (
                      <a
                        href={e.page != null ? `${e.url}#page=${e.page}` : e.url}
                        target="_blank"
                        rel="noreferrer"
                        className="underline decoration-line underline-offset-2 hover:decoration-ink"
                      >
                        {where}
                      </a>
                    ) : (
                      where
                    )}
                    {")"}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
