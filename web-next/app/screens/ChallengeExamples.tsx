"use client";

import { useState } from "react";
import { NCT, verifyRecommendation, type Recommendation, type Selection, type Verification } from "@/lib/api";
import { Failed, Frame } from "../components/Frame";
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
          <p data-testid={`reason-${example.key}`} className="text-base text-ink">
            {reasonOf(run.data)}
          </p>
        </div>
      ) : null}
      {run.status === "error" ? <Failed message={run.message} /> : null}
    </li>
  );
}

const EXAMPLES_LABEL = "Example arguments written by the ProtocolOS team";

// Verify tab. The worked examples are about EL3's ANC and hemoglobin rules, so they appear only for that trial.
export default function ChallengeExamples({ nct, criterionId }: Selection) {
  if (nct === NCT && criterionId === "anc") {
    return (
      <div className="flex flex-col gap-2">
        <p data-testid="examples-label" className="text-xs font-medium uppercase tracking-wide text-muted">{EXAMPLES_LABEL}</p>
        <Screen5 nct={nct} />
      </div>
    );
  }

  if (nct === NCT && criterionId === "hemoglobin") {
    return (
      <Frame
        headline="Three arguments, one verifier."
        caption="Each suggestion is checked against the protocols and the FDA text; a false citation is rejected, a risky relaxation goes to medical review."
      >
        <p data-testid="examples-label" className="text-xs font-medium uppercase tracking-wide text-muted">{EXAMPLES_LABEL}</p>
        <ul className="grid w-full grid-cols-1 gap-3 lg:grid-cols-3">
          {HEMOGLOBIN_EXAMPLES.map((example) => (
            <ExampleCard key={example.key} nct={nct} example={example} />
          ))}
        </ul>
      </Frame>
    );
  }

  return (
    <Frame headline="Verify a change." caption="The worked examples cover the EL3 trial's ANC and hemoglobin rules; pick one of those to see the verifier check an argument.">
      <p className="text-base text-muted">No worked example for this criterion yet.</p>
    </Frame>
  );
}
