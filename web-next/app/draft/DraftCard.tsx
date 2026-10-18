import { DISPLAY_CLASSIFICATION, type DraftCriterion, type EngineClassification } from "@/lib/contracts";
import { RationaleBadges } from "../components/RationaleBadges";

const EDGE: Record<EngineClassification, string> = {
  "Review recommended": "border-l-look",
  "Evidence supports retaining": "border-l-support",
  "Insufficient evidence": "border-l-uncounted",
};

const CHIP: Record<EngineClassification, string> = {
  "Review recommended": "bg-look-soft text-ink",
  "Evidence supports retaining": "bg-support-soft text-ink",
  "Insufficient evidence": "bg-uncounted-soft text-muted",
};

function Icon({ d, className = "" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
const CHECK = "M3 8.5l3 3 7-7";
const WARN = "M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5v.01";
const CROSS = "M4 4l8 8M12 4l-8 8";
const QUESTION = "M6 6a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5M8 12v.01";

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
}

// One bar per distinct precedent value; each trial id links to the protocol page the verifier matched.
function Distribution({ c, drafted }: { c: DraftCriterion; drafted: boolean }) {
  if (c.distribution.length === 0) return null;
  const total = c.distribution.reduce((s, d) => s + d.count, 0) || 1;
  const byNct = new Map(c.rationale.precedents.map((p) => [p.nct_id, p]));
  return (
    <div data-testid="draft-distribution" className="flex flex-col gap-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        {drafted ? "What regimen-matched precedents used" : "Values in matched trials (context only, no value proposed)"}
      </p>
      <ul className="flex flex-col gap-1">
        {c.distribution.map((d) => {
          const chosen = c.proposed !== null && d.operator === c.proposed.operator && d.value === c.proposed.value;
          return (
            <li key={`${d.operator}${d.value}${d.unit}`} className="grid grid-cols-[5.5rem_1fr] items-center gap-2 text-xs sm:grid-cols-[7rem_1fr]">
              <span className={`tabular-nums ${chosen ? "font-semibold text-ink" : "text-muted"}`}>
                {d.operator}
                {fmt(d.value)} {d.unit}
              </span>
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="h-2 rounded-sm bg-uncounted-soft">
                  <div className={`h-2 rounded-sm ${chosen ? "bg-ink" : "bg-uncounted"}`} style={{ width: `${(d.count / total) * 100}%` }} />
                </div>
                <span className="flex flex-wrap gap-x-2 text-muted">
                  <span>{d.count}×</span>
                  {d.nct_ids.map((n) => {
                    const p = byNct.get(n);
                    const label = p?.acronym ?? n;
                    return p?.url ? (
                      <a key={n} href={p.page ? `${p.url}#page=${p.page}` : p.url} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:text-ink" title={p.quote}>
                        {label}
                        {p.page ? ` p.${p.page}` : ""}
                      </a>
                    ) : (
                      <span key={n}>{label}</span>
                    );
                  })}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Checks({ c }: { c: DraftCriterion }) {
  const v = c.verification;
  if (!v) {
    return (
      <p data-testid="draft-checks" data-status="NOT_RUN" className="text-xs text-muted">
        Verifier not run: no value was proposed.
      </p>
    );
  }
  const pass = v.checks.filter((k) => k.result === "pass").length;
  const warn = v.checks.filter((k) => k.result === "warn").length;
  const fail = v.checks.filter((k) => k.result === "fail").length;
  const tone = v.status === "PASSED" ? "text-support" : v.status === "REJECTED" ? "text-verdict" : "text-look";
  return (
    <details data-testid="draft-checks" data-status={v.status} className="group text-xs">
      <summary className="flex cursor-pointer select-none flex-wrap items-center gap-x-3 gap-y-1 text-ink">
        <span className={`inline-flex items-center gap-1 font-medium ${tone}`}>
          <Icon d={v.status === "REJECTED" ? CROSS : v.status === "PASSED" ? CHECK : WARN} />
          Verifier: {v.status.replaceAll("_", " ").toLowerCase()}
        </span>
        <span className="text-muted">
          {pass} pass · {warn} warn{fail ? ` · ${fail} fail` : ""}
        </span>
        <span className="text-muted underline decoration-line underline-offset-2 group-open:hidden">show checks</span>
      </summary>
      <ul className="mt-1.5 flex flex-col gap-1 border-l border-line pl-3">
        {v.checks.map((k, i) => (
          <li key={`${k.check}-${i}`} className="flex gap-1.5">
            <Icon d={k.result === "pass" ? CHECK : k.result === "warn" ? WARN : CROSS} className={k.result === "pass" ? "text-support" : k.result === "warn" ? "text-look" : "text-verdict"} />
            <span>
              <span className="font-medium text-ink">{k.check.replaceAll("_", " ")}</span> <span className="text-muted">{k.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export default function DraftCard({ c }: { c: DraftCriterion }) {
  const cls = c.critique.classification;
  const drafted = c.status === "drafted" && c.proposed !== null;
  // The engine's last why line repeats the self-critique shown below, and its explanation starts with the engine label
  // that the chip already shows under its display name.
  const why = c.why_generated.filter((w) => !w.startsWith("Self-critique:"));
  const rest = c.critique.explanation.startsWith(`${cls}: `) ? c.critique.explanation.slice(cls.length + 2) : c.critique.explanation;
  // On an insufficient card the reason is already stated above the strip; the critique repeats it, so it is shown once.
  const reason = drafted ? null : c.insufficient_reason;
  const explanation = reason && rest.includes(reason) ? null : rest.charAt(0).toUpperCase() + rest.slice(1);
  const missing = c.critique.missing_evidence.filter((m) => m !== reason);
  return (
    <article
      data-testid="draft-criterion"
      data-status={c.status}
      data-analyte={c.analyte}
      className={`flex flex-col gap-3 rounded-lg border border-line border-l-4 bg-white p-3 sm:p-4 ${EDGE[cls]}`}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wide text-muted">
            {c.section} · {c.category.replace("_", " ")}
          </p>
          <h3 className="text-base font-semibold text-ink">{c.label}</h3>
        </div>
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${CHIP[cls]}`}>
          <Icon d={drafted ? CHECK : QUESTION} />
          {drafted ? "Drafted" : "Insufficient evidence"}
        </span>
      </header>

      {drafted && c.proposed ? (
        <p data-testid="draft-value" className="text-2xl font-semibold tabular-nums tracking-tight text-ink">
          {c.proposed.operator}
          {fmt(c.proposed.value)} <span className="text-base font-medium text-muted">{c.proposed.unit}</span>
          <span className="mt-0.5 block text-xs font-normal tracking-normal text-muted">{c.proposed.text}</span>
        </p>
      ) : (
        <p data-testid="draft-insufficient" className="rounded-md bg-uncounted-soft px-3 py-2 text-sm text-ink">
          No value proposed. {c.insufficient_reason ?? "No regimen-matched precedent the verifier could match."}
        </p>
      )}

      {c.rationale.categories.length > 0 ? <RationaleBadges categories={c.rationale.categories} size="sm" /> : null}

      <Distribution c={c} drafted={drafted} />

      {why.length > 0 ? (
        <section data-testid="draft-why" className="text-sm">
          <h4 className="font-medium text-ink">{drafted ? "Why this value" : "Context"}</h4>
          <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 text-muted">
            {why.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <Checks c={c} />

      <section data-testid="draft-critique" data-classification={cls} className="rounded-md border border-line px-3 py-2 text-sm">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Self-critique</span>
          <span className={`rounded px-1.5 text-xs font-medium ${CHIP[cls]}`}>{DISPLAY_CLASSIFICATION[cls]}</span>
        </p>
        {explanation ? <p className="mt-1 text-ink">{explanation}</p> : null}
        {missing.length > 0 ? (
          <div className="mt-1 text-xs text-muted">
            <p className="font-medium">Missing evidence</p>
            <ul className="list-disc pl-4">
              {missing.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {c.critique.suggested_action.text ? <p className="mt-1 text-xs text-muted">Next: {c.critique.suggested_action.text}</p> : null}
      </section>
    </article>
  );
}
