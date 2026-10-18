"use client";

import { useEffect, useState } from "react";
import { getReview } from "@/lib/api";
import { getRationale, type MissingCriterion } from "@/lib/contracts";

type State =
  | { nct: string; status: "ready"; missing: MissingCriterion[]; comparators: number }
  | { nct: string; status: "error" };

// Criteria most comparable protocols state but this protocol's extraction lacks (`missing` in /api/rationale).
// Extraction misses are possible, so each item is a question to check in the protocol, not a finding.
export function MissingCriteria({ nct }: { nct: string }) {
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    let live = true;
    // The review only after the rationale loaded: the rationale answers 403 for an uncached trial on the public
    // demo, where requesting the review would start computing it.
    getRationale(nct)
      .then((report) => getReview(nct).then((review) => ({ report, review })))
      .then(
        ({ report, review }) =>
          live && setState({ nct, status: "ready", missing: report.missing, comparators: review.comparators.length }),
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
        Could not load the comparison with comparable protocols, so missing criteria were not checked.
      </p>
    );
  }
  if (current.missing.length === 0) {
    // Same threshold as rationale.missing_criteria: stated by at least max(2, ceil(0.75*M)) of the M comparators.
    const m = current.comparators;
    return (
      <p data-testid="missing-none" className="text-sm text-muted">
        {m < 2
          ? "Fewer than 2 comparable protocols were found for this trial, so missing criteria were not checked."
          : `No gaps found: every criterion stated by at least ${Math.max(2, Math.ceil(0.75 * m))} of the ${m} comparable protocols was also extracted from this protocol.`}
      </p>
    );
  }
  return (
    <section aria-labelledby="missing-heading" className="flex flex-col gap-2">
      <h2 id="missing-heading" className="text-sm font-semibold text-ink">
        Possibly missing: check the protocol
      </h2>
      <ul data-testid="missing-criteria" className="flex flex-col gap-3">
        {current.missing.map((m) => (
          <li
            key={m.criterion_id}
            data-testid="missing-item"
            data-criterion={m.criterion_id}
            className="rounded-md border border-look bg-look-soft/40 px-3 py-2.5"
          >
            <p className="font-semibold text-ink">{m.label}</p>
            <p className="mt-1 text-sm text-ink">{m.text}</p>
            {m.examples.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-2 text-sm text-muted">
                {m.examples.map((e) => {
                  const name = e.acronym ?? e.nct_id;
                  const where = e.page != null ? `${name}, p. ${e.page}` : `${name} protocol`;
                  return (
                    <li key={e.nct_id} className="flex flex-col">
                      <span>
                        <span className="text-ink">{name}</span>: {e.threshold}
                      </span>
                      {e.quote ? (
                        <span data-role="quote" className="text-xs text-ink">
                          &ldquo;{e.quote}&rdquo;
                        </span>
                      ) : null}
                      {e.url ? (
                        <a
                          href={e.page != null ? `${e.url}#page=${e.page}` : e.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex min-h-11 items-center self-start text-ink underline decoration-uncounted underline-offset-2 hover:decoration-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
                        >
                          Open {where}
                        </a>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
