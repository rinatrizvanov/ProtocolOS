"use client";

import { useState } from "react";
import {
  NCT,
  getReview,
  verifyRecommendation,
  whatIf,
  type Check,
  type Recommendation,
  type Selection,
  type Verification,
  type WhatIf,
} from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Failed, Frame, Pending } from "../components/Frame";
import Screen5 from "./Screen5";

type ExampleKey = "made_up" | "honest_risky" | "cautious";
type Run = { status: "idle" } | { status: "busy" } | { status: "error"; message: string } | { status: "ready"; data: Verification };

// Reviewer inputs for the hemoglobin rule, not engine output: the verifier decides each one.
const HEMOGLOBIN_EXAMPLES: { key: ExampleKey; title: string; body: Recommendation }[] = [
  {
    key: "made_up",
    title: "Made-up citation",
    body: {
      criterion_id: "hemoglobin",
      action: "relax",
      proposed_value: 8.0,
      proposed_unit: "g/dL",
      text: "CheckMate 9LA allowed hemoglobin of 8.0 g/dL, so 8.0 g/dL is safe.",
      claims: [{ type: "comparator_threshold", nct_id: "NCT03215706", value: 8.0, unit: "g/dL" }],
    },
  },
  {
    key: "honest_risky",
    title: "Honest, but risky",
    body: {
      criterion_id: "hemoglobin",
      action: "relax",
      proposed_value: 9.0,
      proposed_unit: "g/dL",
      text: "Comparable trials used 9.0 g/dL; consider whether 9.0 g/dL fits this regimen.",
      claims: [
        { type: "comparator_threshold", nct_id: "NCT03215706", value: 9.0, unit: "g/dL" },
        { type: "comparator_threshold", nct_id: "NCT02477826", value: 9.0, unit: "g/dL" },
        { type: "comparator_threshold", nct_id: "NCT02220894", value: 9.0, unit: "g/dL" },
      ],
    },
  },
  {
    key: "cautious",
    title: "Cautious",
    body: {
      criterion_id: "hemoglobin",
      action: "justify_in_protocol",
      proposed_value: null,
      proposed_unit: "g/dL",
      text: "Comparable PD-1 + chemotherapy trials used 9.0 g/dL; document why 10.0 g/dL is required.",
      claims: [
        { type: "comparator_threshold", nct_id: "NCT03215706", value: 9.0, unit: "g/dL" },
        {
          type: "fda_quote",
          guidance: "lab",
          quote: "Laboratory-based eligibility criteria should be only as restrictive as necessary to mitigate the clinical risk(s) of concern.",
        },
      ],
    },
  },
];

const OUTCOME_TONE: Record<string, string> = {
  Rejected: "text-verdict",
  "Needs medical review": "text-look",
  Supported: "text-support",
};

function reasonOf(data: Verification): string {
  const checks = data.deterministic.checks;
  const shown = checks.find((c) => c.result === "fail") ?? checks.find((c) => c.result === "warn");
  return shown?.detail ?? "Every check passed.";
}

function ExampleCard({ nct, example }: { nct: string; example: (typeof HEMOGLOBIN_EXAMPLES)[number] }) {
  const [run, setRun] = useState<Run>({ status: "idle" });

  function verify() {
    setRun({ status: "busy" });
    verifyRecommendation(nct, example.body).then(
      (data) => setRun({ status: "ready", data }),
      (err: unknown) => {
        console.error(err);
        setRun({ status: "error", message: err instanceof Error ? err.message : String(err) });
      },
    );
  }

  return (
    <li className="flex flex-col gap-3 rounded-md border border-line bg-white/60 p-4">
      <h2 className="text-base font-semibold text-ink">{example.title}</h2>
      <blockquote className="border-l-4 border-line pl-4 text-base font-medium text-ink">{example.body.text}</blockquote>
      <button
        type="button"
        data-testid={`challenge-${example.key}`}
        onClick={verify}
        disabled={run.status === "busy"}
        className="self-start rounded-md border border-ink bg-ink px-4 py-2 text-base text-paper transition-opacity duration-150 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
      >
        {run.status === "busy" ? "Checking…" : "Run the verifier"}
      </button>
      {run.status === "ready" ? (
        <div className="flex flex-col gap-2">
          <span
            data-testid={`outcome-${example.key}`}
            className={`text-3xl font-semibold ${OUTCOME_TONE[run.data.deterministic.outcome] ?? "text-ink"}`}
          >
            {run.data.deterministic.outcome}
          </span>
          <figure>
            <figcaption className="text-xs font-medium text-muted">Verifier, verbatim</figcaption>
            <p data-testid={`reason-${example.key}`} data-role="quote" className="text-base text-ink">
              {reasonOf(run.data)}
            </p>
          </figure>
        </div>
      ) : null}
      {run.status === "error" ? <Failed message={run.message} /> : null}
    </li>
  );
}

const RESULT: Record<string, { label: string; tone: string }> = {
  fail: { label: "Fail", tone: "text-verdict" },
  warn: { label: "Warning", tone: "text-look" },
  pass: { label: "Pass", tone: "text-support" },
};

// The engine compares each similar trial with the proposed limit; shown in the panel's words.
const RELATION: Record<string, string> = {
  "same as alternative": "same as the proposed limit",
  "more permissive than alternative": "less strict than the proposed limit",
  "stricter than alternative": "stricter than the proposed limit",
};

type WhatIfRun = { status: "idle" } | { status: "busy" } | { status: "error"; message: string } | { status: "ready"; data: WhatIf };

// The same check can fire once per cited trial with identical text; list each distinct line once.
function distinct(checks: Check[]): Check[] {
  const seen = new Set<string>();
  return checks.filter((c) => {
    const key = `${c.check}|${c.result}|${c.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function CheckList({ checks }: { checks: Check[] }) {
  return (
    <ul data-role="quote" className="flex flex-col gap-1 text-sm">
      {checks.map((c) => (
        <li key={`${c.check}|${c.result}|${c.detail}`} className="flex gap-2">
          <span className={`w-16 shrink-0 font-medium ${RESULT[c.result]?.tone ?? "text-ink"}`}>{RESULT[c.result]?.label ?? c.result}</span>
          <span className="min-w-0 text-ink">{c.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function WhatIfResult({ data, operator, current, unit }: { data: WhatIf; operator: string; current: number; unit: string }) {
  const checks = distinct(data.verification.checks);
  const flagged = checks.filter((c) => c.result !== "pass");
  const passed = checks.filter((c) => c.result === "pass");
  const names = new Map(data.comparators.map((r) => [r.nct_id, r.acronym ?? r.nct_id]));
  const cited = data.auto_recommendation.claims.flatMap((c) => (c.type === "comparator_threshold" ? [names.get(c.nct_id) ?? c.nct_id] : []));
  const pop = data.population;
  return (
    <div data-testid="whatif-result" className="flex flex-col gap-3 border-t border-line pt-3">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span data-testid="whatif-outcome" className={`text-2xl font-semibold ${OUTCOME_TONE[data.verification.outcome] ?? "text-ink"}`}>
          {data.verification.outcome}
        </span>
        <span className="text-sm tabular-nums text-muted">
          {operator} {data.alternative} {unit} instead of {operator} {current} {unit}
        </span>
      </p>
      <p className="text-sm text-ink">
        {cited.length > 0
          ? `The change cites the ${cited.length === 1 ? "similar trial" : `${cited.length} similar trials`} that used this limit: ${cited.join(", ")}.`
          : "No similar trial used this limit, so the change cites none."}
      </p>
      <figure className="flex flex-col gap-1">
        <figcaption className="text-xs font-medium text-muted">Verifier checks, verbatim</figcaption>
        {flagged.length > 0 ? <CheckList checks={flagged} /> : null}
        {passed.length > 0 ? (
          <details className="text-sm text-muted">
            <summary className="cursor-pointer select-none py-1 text-ink">
              {passed.length} {passed.length === 1 ? "check" : "checks"} passed
            </summary>
            <CheckList checks={passed} />
          </details>
        ) : null}
      </figure>
      {data.comparators.length > 0 ? (
        <ul className="grid gap-x-4 gap-y-1 text-sm text-ink sm:grid-cols-2">
          {data.comparators.map((r) => (
            <li key={r.nct_id}>
              {r.acronym ?? r.nct_id} <span className="tabular-nums text-muted">{r.threshold}</span>: {RELATION[r.relation_to_alternative] ?? r.relation_to_alternative}
            </li>
          ))}
        </ul>
      ) : null}
      {pop ? (
        <div data-testid="whatif-population" className="flex flex-col gap-1 rounded-md bg-line/40 px-3 py-2">
          <p className="text-sm tabular-nums text-ink">
            US adults below the limit ({pop.current.source.dataset}, n = {pop.current.overall.n.toLocaleString("en-US")}):{" "}
            <span className="font-semibold">{pop.current.overall.pct}%</span> at {operator} {current} {unit},{" "}
            <span className="font-semibold">{pop.alternative.overall.pct}%</span> at {operator} {data.alternative} {unit}.
          </p>
          <p className="text-xs text-muted">{pop.current.caveat}</p>
        </div>
      ) : null}
    </div>
  );
}

// "Try another limit" for any numeric criterion: POST /api/whatif builds the change from the similar trials that
// used exactly that limit, and the deterministic verifier decides it.
function WhatIfPanel({ nct, criterionId }: Selection) {
  const review = useApi(() => getReview(nct));
  const [draft, setDraft] = useState<string | null>(null);
  const [run, setRun] = useState<WhatIfRun>({ status: "idle" });
  if (review.status === "loading") return <Pending label="Loading the criterion…" />;
  if (review.status === "error") return <Failed message={review.message} />;
  const criterion = review.data.reviews.find((r) => r.criterion.id === criterionId)?.criterion;
  if (!criterion || criterion.value_norm === null) return null;
  const current = criterion.value_norm;
  const unit = criterion.unit_norm ?? "";

  // Values the similar trials used that differ from this one, most common first; the first prefills the field. A limit
  // on a different measure is not comparable, so, as in the engine's /api/whatif, it is neither a value nor a precedent.
  const counts = new Map<number, number>();
  const otherMeasures = new Set<string>();
  let stated = 0;
  for (const row of review.data.comparison[criterionId] ?? []) {
    const v = row.criterion?.value_norm;
    if (!row.criterion || v === null || v === undefined) continue;
    if (row.direction === "different measure") {
      otherMeasures.add(row.criterion.label);
      continue;
    }
    stated += 1;
    if (v !== current) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const used = [...counts.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0] - current) - Math.abs(b[0] - current));
  const value = draft ?? (used.length > 0 ? String(used[0][0]) : "");
  const proposed = Number(value);
  const isCurrent = value.trim() !== "" && proposed === current;
  const valid = value.trim() !== "" && Number.isFinite(proposed) && proposed >= 0 && !isCurrent;

  function check() {
    if (!valid) return;
    setRun({ status: "busy" });
    whatIf(nct, criterionId, proposed).then(
      (data) => setRun({ status: "ready", data }),
      (err: unknown) => {
        console.error(err);
        setRun({ status: "error", message: err instanceof Error ? err.message : String(err) });
      },
    );
  }

  return (
    <section data-testid="whatif" aria-labelledby="whatif-heading" className="flex flex-col gap-3 rounded-lg border border-line bg-white/60 p-4">
      <div className="flex flex-col gap-1">
        <h2 id="whatif-heading" className="text-base font-semibold text-ink">
          Try another limit
        </h2>
        <p className="text-sm text-muted">
          ProtocolOS writes the change, citing the similar trials that used exactly that limit, and the deterministic verifier checks it.
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          check();
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <label className="flex flex-col gap-1 text-sm text-muted">
          {criterion.label}
          <span className="flex items-center gap-2 text-base text-ink">
            <span className="tabular-nums">{criterion.operator}</span>
            <input
              data-testid="whatif-value"
              type="number"
              inputMode="decimal"
              step="any"
              min={0}
              value={value}
              onChange={(e) => setDraft(e.target.value)}
              aria-describedby={isCurrent ? "whatif-hint" : undefined}
              className="w-28 rounded-md border border-line bg-paper px-2 py-1.5 tabular-nums text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
            />
            <span>{unit}</span>
          </span>
        </label>
        <button
          type="submit"
          data-testid="whatif-run"
          disabled={!valid || run.status === "busy"}
          className="rounded-md border border-ink bg-ink px-4 py-2 text-sm text-paper transition-opacity duration-150 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          {run.status === "busy" ? "Checking…" : "Check this limit"}
        </button>
      </form>
      {isCurrent ? (
        <p id="whatif-hint" className="text-sm text-muted">
          That is the current limit; enter a different one.
        </p>
      ) : null}
      {used.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          Values similar trials used:
          {used.map(([v, n]) => (
            <button
              key={v}
              type="button"
              data-testid="whatif-chip"
              onClick={() => setDraft(String(v))}
              className="rounded-full border border-line px-2.5 py-0.5 tabular-nums text-ink transition-colors duration-150 hover:border-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
            >
              {v} {unit} <span className="text-muted">({n} {n === 1 ? "trial" : "trials"})</span>
            </button>
          ))}
        </div>
      ) : (
        <p data-testid="whatif-precedent" className="text-sm text-muted">
          {review.data.comparators.length === 0
            ? "No similar trial was found for this protocol, so a change would cite none."
            : stated === 0 && otherMeasures.size > 0
              ? `The similar trials that state this criterion use a different measure, ${[...otherMeasures].join("; ")}, so a change would cite none.`
              : stated === 0
                ? "No similar trial states a numeric limit for this criterion, so a change would cite none."
                : "Every similar trial with a comparable numeric limit for this criterion used this one."}
        </p>
      )}
      {run.status === "ready" ? <WhatIfResult data={run.data} operator={criterion.operator} current={current} unit={unit} /> : null}
      {run.status === "error" ? <Failed message={run.message} /> : null}
    </section>
  );
}

const EXAMPLES_LABEL = "Example arguments written by the ProtocolOS team";

// Verify tab: "Try another limit" for every criterion; EL3's ANC and hemoglobin rules also show worked examples.
export default function ChallengeExamples({ nct, criterionId }: Selection) {
  if (nct === NCT && criterionId === "anc") {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <p data-testid="examples-label" className="text-xs font-medium uppercase tracking-wide text-muted">{EXAMPLES_LABEL}</p>
          <Screen5 nct={nct} />
        </div>
        <WhatIfPanel nct={nct} criterionId={criterionId} />
      </div>
    );
  }

  if (nct === NCT && criterionId === "hemoglobin") {
    return (
      <Frame
        headline="Three arguments, one verifier."
        caption="Each suggestion is checked against the protocols and the FDA text; a false citation is rejected, a risky relaxation goes to medical review."
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p data-testid="examples-label" className="text-xs font-medium uppercase tracking-wide text-muted">{EXAMPLES_LABEL}</p>
            <ul className="grid w-full grid-cols-1 gap-3 lg:grid-cols-3">
              {HEMOGLOBIN_EXAMPLES.map((example) => (
                <ExampleCard key={example.key} nct={nct} example={example} />
              ))}
            </ul>
          </div>
          <WhatIfPanel nct={nct} criterionId={criterionId} />
        </div>
      </Frame>
    );
  }

  return (
    <Frame headline="Verify a change." caption="Propose another limit; the deterministic verifier checks the change and every trial it cites.">
      <WhatIfPanel nct={nct} criterionId={criterionId} />
    </Frame>
  );
}
