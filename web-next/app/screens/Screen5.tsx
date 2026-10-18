"use client";

import { useState } from "react";
import { ANC_CLAIM_TEXT, getReview, verifyAncClaim, type Verification } from "@/lib/api";
import { Failed, Frame } from "../components/Frame";

type Run = { status: "idle" } | { status: "busy" } | { status: "error"; message: string } | { status: "ready"; data: Verification };

const RESULT_TEXT: Record<string, { label: string; tone: string }> = {
  fail: { label: "Fail", tone: "text-verdict" },
  warn: { label: "Warning", tone: "text-look-ink" },
  pass: { label: "Pass", tone: "text-support" },
};

// The claim is checked in the unit the protocol itself uses for ANC.
async function verifyInProtocolUnit(nct: string): Promise<Verification> {
  const review = await getReview(nct);
  const unit = review.reviews.find((r) => r.criterion.id === "anc")?.criterion.unit_norm;
  if (!unit) throw new Error("The review has no ANC criterion with a unit");
  return verifyAncClaim(nct, unit);
}

export default function Screen5({ nct }: { nct: string }) {
  const [run, setRun] = useState<Run>({ status: "idle" });

  function verify() {
    setRun({ status: "busy" });
    verifyInProtocolUnit(nct).then(
      (data) => setRun({ status: "ready", data }),
      (err: unknown) => setRun({ status: "error", message: err instanceof Error ? err.message : String(err) }),
    );
  }

  const checks = run.status === "ready" ? run.data.deterministic.checks : [];
  const firstFail = checks.find((c) => c.result === "fail");

  return (
    <Frame
      headline="A wrong argument is caught."
      caption="The deterministic verifier checks every claim against the protocol, the drug table and the FDA text; one failed check rejects the suggestion."
      details={
        checks.length ? (
          <figure>
            <figcaption className="text-xs font-medium text-muted">Verifier checks, verbatim</figcaption>
            <ul data-role="quote" className="mt-1 space-y-1">
              {checks.map((c, i) => (
                <li key={`${c.check}-${i}`} className="flex gap-2">
                  <span className={`w-16 shrink-0 font-medium ${RESULT_TEXT[c.result]?.tone ?? "text-ink"}`}>{RESULT_TEXT[c.result]?.label ?? c.result}</span>
                  <span className="min-w-0 text-ink">{c.detail}</span>
                </li>
              ))}
            </ul>
          </figure>
        ) : undefined
      }
    >
      <div className="flex w-full max-w-3xl flex-col gap-8">
        <figure className="flex flex-col gap-2">
          <figcaption className="text-xs font-medium text-muted">Example argument written by the ProtocolOS team</figcaption>
          <blockquote data-testid="anc-claim" className="border-l-4 border-line pl-6 text-2xl font-medium text-ink">
            &ldquo;{ANC_CLAIM_TEXT}&rdquo;
          </blockquote>
        </figure>
        {run.status === "ready" ? (
          <div className="flex flex-col gap-2">
            <span data-testid="verdict" className="text-5xl font-semibold capitalize text-verdict">
              {run.data.deterministic.outcome}
            </span>
            {firstFail ? (
              <figure>
                <figcaption className="text-xs font-medium text-muted">Why, verbatim from the verifier</figcaption>
                <p data-testid="verdict-reason" data-role="quote" className="text-lg text-ink">
                  {firstFail.detail}
                </p>
              </figure>
            ) : (
              <p data-testid="verdict-reason" className="text-lg text-ink">
                No check failed.
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-4">
            <button
              type="button"
              data-testid="run-verifier"
              onClick={verify}
              disabled={run.status === "busy"}
              className="rounded-md border border-ink bg-ink px-6 py-3 text-lg text-paper transition-opacity duration-150 disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              {run.status === "busy" ? "Checking…" : "Run the verifier"}
            </button>
            {run.status === "error" ? <Failed message={run.message} action="run the verifier" /> : null}
          </div>
        )}
      </div>
    </Frame>
  );
}
