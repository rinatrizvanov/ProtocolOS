import type { ReactNode } from "react";
import { DISPLAY_CLASSIFICATION, type DraftCriterion, type EngineClassification, type Precedent, type PrecedentValue } from "@/lib/contracts";
import { RationaleBadges } from "../components/RationaleBadges";

export function Icon({ d, className = "" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${className}`} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}
export const CHECK = "M3 8.5l3 3 7-7";
export const WARN = "M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5v.01";
const CROSS = "M4 4l8 8M12 4l-8 8";
const QUESTION = "M6 6a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5M8 12v.01";

// The self-critique verdict: the chip text stays ink for contrast; the hue lives in the chip fill and the icon.
export const VERDICT: Record<EngineClassification, { icon: string; chip: string; tone: string }> = {
  "Review recommended": { icon: WARN, chip: "bg-look-soft", tone: "text-look" },
  "Evidence supports retaining": { icon: CHECK, chip: "bg-support-soft", tone: "text-support" },
  "Insufficient evidence": { icon: QUESTION, chip: "bg-uncounted-soft", tone: "text-muted" },
};

// Verdict order on the page: what needs a look first, what is kept last.
export const DISPLAY_ORDER: EngineClassification[] = ["Review recommended", "Insufficient evidence", "Evidence supports retaining"];

export function verdictLabel(c: DraftCriterion): string {
  const cls = c.critique.classification;
  // A drafted value can still get this verdict: one precedent used it, but nothing explains this exact value.
  return cls === "Insufficient evidence" && c.status === "drafted" ? "Insufficient evidence for this value" : DISPLAY_CLASSIFICATION[cls];
}

export function VerdictChip({ c }: { c: DraftCriterion }) {
  const v = VERDICT[c.critique.classification];
  return (
    <span data-testid="draft-verdict" className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium text-ink ${v.chip}`}>
      <Icon d={v.icon} className={v.tone} />
      {verdictLabel(c)}
    </span>
  );
}

export function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
}

function pageHref(p: { url: string | null; page: number | null }): string | null {
  if (!p.url) return null;
  return p.page ? `${p.url}#page=${p.page}` : p.url;
}

const CONNECTOR = /^(or|and|nor|but|the|a|an|of|to|in|on|at|by|for|with|than|that|if|unless|who|which)$/i;
const WORD = /^[A-Za-z][A-Za-z-]*$/;

// Precedent quotes are verbatim protocol text cut at a line or table-cell edge; an ellipsis marks where a sentence
// was cut, and runs of table spacing collapse to one space.
function excerpt(raw: string): string {
  let q = raw.replace(/\s+/g, " ").trim();
  const lead = /^[a-z]{2,}/.test(q) ? "…" : "";
  if (/[,;:]$/.test(q)) {
    q = `${q.slice(0, -1)}…`;
  } else if (!/[.!?)"”]$/.test(q)) {
    const words = q.split(" ");
    const last = words[words.length - 1] ?? "";
    const prev = words[words.length - 2] ?? "";
    if (CONNECTOR.test(last) || (WORD.test(last) && WORD.test(prev))) q = `${q}…`;
  }
  return `${lead}${q}`;
}

function TrialLink({ p, precedents, children }: { p: PrecedentValue; precedents: Map<string, Precedent>; children: ReactNode }) {
  const href = pageHref(p);
  const study = precedents.get(p.nct_id);
  // The trial's registry title and start date are a supplement; the id and page are always visible.
  const hint = study ? `${study.title}${study.start_date ? ` (started ${study.start_date})` : ""}` : undefined;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" title={hint} className="underline decoration-line underline-offset-2 hover:text-ink">
      {children}
    </a>
  ) : (
    <span title={hint}>{children}</span>
  );
}

// One bar per distinct precedent value; each trial id links to the protocol page the verifier matched.
function Distribution({ c, drafted, precedents }: { c: DraftCriterion; drafted: boolean; precedents: Map<string, Precedent> }) {
  if (c.distribution.length === 0) return null;
  const total = c.distribution.reduce((s, d) => s + d.count, 0) || 1;
  const byNct = new Map(c.rationale.precedents.map((p) => [p.nct_id, p]));
  return (
    <div data-testid="draft-distribution" className="flex flex-col gap-1.5">
      <h4 className="text-xs font-medium text-muted">
        {drafted ? "What regimen-matched precedents used" : "Values in matched trials (context only, no value proposed)"}
      </h4>
      <ul className="flex flex-col gap-1.5">
        {c.distribution.map((d) => {
          const chosen = c.proposed !== null && d.operator === c.proposed.operator && d.value === c.proposed.value;
          return (
            <li key={`${d.operator}${d.value}${d.unit}`} className="grid grid-cols-[5.5rem_1fr] items-start gap-2 text-xs sm:grid-cols-[6.5rem_1fr]">
              <span className={`tabular-nums ${chosen ? "font-semibold text-ink" : "text-muted"}`}>
                {d.operator}
                {fmt(d.value)} {d.unit}
              </span>
              <div className="flex min-w-0 flex-col gap-1 pt-1">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 rounded-sm bg-uncounted-soft">
                    <div className={`h-1.5 rounded-sm ${chosen ? "bg-ink" : "bg-uncounted"}`} style={{ width: `${(d.count / total) * 100}%` }} />
                  </div>
                  <span className="w-6 text-right tabular-nums text-muted">{d.count}×</span>
                </div>
                <span className="flex flex-wrap gap-x-2 text-muted">
                  {d.nct_ids.map((n) => {
                    const p = byNct.get(n);
                    if (!p) return <span key={n}>{n}</span>;
                    return (
                      <TrialLink key={n} p={p} precedents={precedents}>
                        {p.acronym ?? n}
                        {p.page ? ` p.${p.page}` : ""}
                      </TrialLink>
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

// Reader-facing names for the verifier's check ids; any other id is shown with its underscores as spaces.
const CHECK_NAMES: Record<string, string> = {
  criterion_exists: "Criterion identified",
  plausibility: "Value in a plausible range",
  comparator_value: "Precedent value matches its protocol",
  fda_quote: "FDA quote found verbatim",
  drug_property: "Drug property matches the curated table",
};

function checkDetail(detail: string): string {
  // The curated pharmacology table reports properties as flags, e.g. "carboplatin myelosuppressive=True".
  return detail
    .replace(/\b([a-z_]+)=True\b/g, (_, p: string) => p.replaceAll("_", " "))
    .replace(/\b([a-z_]+)=False\b/g, (_, p: string) => `not ${p.replaceAll("_", " ")}`);
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
  const icon = v.status === "PASSED" ? CHECK : v.status === "REJECTED" ? CROSS : WARN;
  // Amber is too light for text, so a warning keeps the label in ink and puts the hue on the icon only.
  const tone = v.status === "PASSED" ? "text-support" : v.status === "REJECTED" ? "text-verdict" : "text-look";
  const labelTone = v.status === "PASSED_WITH_WARNINGS" ? "text-ink" : tone;
  const label = v.status === "PASSED" ? "Verifier: passed" : v.status === "REJECTED" ? "Verifier: rejected" : "Verifier: passed with warnings";
  return (
    <details data-testid="draft-checks" data-status={v.status} className="group text-xs">
      <summary className="flex cursor-pointer select-none flex-wrap items-center gap-x-3 gap-y-1 rounded text-ink focus-visible:outline-2 focus-visible:outline-ink">
        <span className={`inline-flex items-center gap-1 font-medium ${labelTone}`}>
          <Icon d={icon} className={tone} />
          {label}
        </span>
        <span className="tabular-nums text-muted">
          {pass} pass · {warn} warn{fail ? ` · ${fail} fail` : ""}
        </span>
        <span className="text-muted underline decoration-line underline-offset-2 group-open:hidden">show checks</span>
        <span className="hidden text-muted underline decoration-line underline-offset-2 group-open:inline">hide checks</span>
      </summary>
      <ul className="mt-1.5 flex flex-col gap-1 border-l border-line pl-3">
        {v.checks.map((k, i) => (
          <li key={`${k.check}-${i}`} className="flex gap-1.5">
            <Icon d={k.result === "pass" ? CHECK : k.result === "warn" ? WARN : CROSS} className={`mt-px ${k.result === "pass" ? "text-support" : k.result === "warn" ? "text-look" : "text-verdict"}`} />
            <span>
              <span className="font-medium text-ink">{CHECK_NAMES[k.check] ?? k.check.replaceAll("_", " ")}</span>{" "}
              <span className="text-muted">{checkDetail(k.detail)}</span>
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

// "Value: …" and "Safety link: …" lines lead with a short label; it is set in ink so the lines scan.
function WhyLine({ text }: { text: string }) {
  const i = text.indexOf(": ");
  if (i > 0 && i <= 24) {
    return (
      <li>
        <span className="font-medium text-ink">{text.slice(0, i)}:</span> {text.slice(i + 2)}
      </li>
    );
  }
  return <li>{text}</li>;
}

export default function DraftCard({ c, precedents }: { c: DraftCriterion; precedents: Map<string, Precedent> }) {
  const cls = c.critique.classification;
  const drafted = c.status === "drafted" && c.proposed !== null;
  // The engine's last why line repeats the self-critique; its FDA lines are citations, listed under their own toggle.
  const why = c.why_generated.filter((w) => !w.startsWith("Self-critique:"));
  const plain = why.filter((w) => !w.startsWith("FDA:"));
  const fda = why.filter((w) => w.startsWith("FDA:")).map((w) => w.replace(/^FDA: (FDA, )?/, "FDA, "));
  // The explanation starts with the engine label the verdict chip shows, and ends with the internal score tally.
  const body = (c.critique.explanation.startsWith(`${cls}: `) ? c.critique.explanation.slice(cls.length + 2) : c.critique.explanation).replace(
    /\s*\(support score \d+, challenge score \d+\)\.?$/,
    "",
  );
  // On an insufficient card the reason is already stated under the heading, so the critique does not repeat it.
  const reason = drafted ? null : c.insufficient_reason;
  const explanation = reason && body.includes(reason) ? null : body.charAt(0).toUpperCase() + body.slice(1);
  const missing = c.critique.missing_evidence.filter((m) => m !== reason);
  const source = c.proposed ? c.rationale.precedents.find((p) => p.nct_id === c.proposed?.source_nct_id) : undefined;
  const sourceCount = c.proposed ? (c.distribution.find((d) => d.operator === c.proposed?.operator && d.value === c.proposed?.value)?.count ?? 1) : 0;
  const sourceName = source ? `${source.acronym ?? source.nct_id}${source.page ? ` p.${source.page}` : ""}` : (c.proposed?.source_nct_id ?? "");

  return (
    <article
      id={`draft-${c.id}`}
      data-testid="draft-criterion"
      data-status={c.status}
      data-analyte={c.analyte}
      className="grid scroll-mt-4 grid-cols-1 gap-x-8 gap-y-3 rounded-lg border border-line bg-white p-4 xl:grid-cols-2"
    >
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 xl:col-span-2">
        <h3 className="min-w-0 text-base font-semibold text-ink">
          {c.label}
          <span className="ml-2 text-xs font-normal capitalize text-muted">{c.section}</span>
        </h3>
        <VerdictChip c={c} />
      </header>

      <div className="flex min-w-0 flex-col gap-3">
        {drafted && c.proposed ? (
          <div className="flex flex-col gap-1">
            <p data-testid="draft-value" className="text-2xl font-semibold leading-tight tabular-nums tracking-tight text-ink">
              {c.proposed.operator}
              {fmt(c.proposed.value)} <span className="text-base font-medium text-muted">{c.proposed.unit}</span>
            </p>
            {source && source.quote.trim() ? (
              <blockquote data-role="quote" className="text-xs leading-relaxed text-muted">
                As worded in{" "}
                <TrialLink p={source} precedents={precedents}>
                  {sourceName}
                </TrialLink>
                : <span className="text-ink">“{excerpt(source.quote)}”</span>
              </blockquote>
            ) : null}
            {cls === "Insufficient evidence" ? (
              <p data-testid="draft-value-note" className="text-xs leading-relaxed text-ink">
                Value taken from {sourceName} ({sourceCount} matched precedent{sourceCount === 1 ? "" : "s"} used it); no rationale for this exact value was
                found, so treat it as a review question.
              </p>
            ) : null}
          </div>
        ) : (
          <p data-testid="draft-insufficient" className="rounded-md bg-uncounted-soft px-3 py-2 text-sm text-ink">
            No value proposed. {c.insufficient_reason ?? "No regimen-matched precedent the verifier could match."}
          </p>
        )}

        <Checks c={c} />

        <section data-testid="draft-critique" data-classification={cls} className="flex flex-col gap-1.5 rounded-md bg-paper px-3 py-2.5 text-sm">
          <h4 className="text-xs font-medium text-muted">Self-critique</h4>
          {explanation ? <p className="text-ink">{explanation}</p> : null}
          {c.critique.suggested_action.text ? (
            <p className="text-ink">
              <span className="font-medium">Next:</span> {c.critique.suggested_action.text}
            </p>
          ) : null}
          {missing.length > 0 ? (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer select-none rounded font-medium focus-visible:outline-2 focus-visible:outline-ink">Not found yet ({missing.length})</summary>
              <ul className="mt-1 list-disc pl-4">
                {missing.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        {plain.length > 0 || fda.length > 0 ? (
          <section data-testid="draft-why" className="flex flex-col gap-1.5 text-sm">
            <h4 className="text-xs font-medium text-muted">{drafted ? "Why this value" : "Context"}</h4>
            {c.rationale.categories.length > 0 ? <RationaleBadges categories={c.rationale.categories} size="sm" /> : null}
            {plain.length > 0 ? (
              <ul className="flex list-disc flex-col gap-1 pl-4 text-[13px] leading-snug text-muted">
                {plain.map((w, i) => (
                  <WhyLine key={i} text={w} />
                ))}
              </ul>
            ) : null}
            {fda.length > 0 ? (
              <details className="text-xs text-muted">
                <summary className="cursor-pointer select-none rounded font-medium focus-visible:outline-2 focus-visible:outline-ink">FDA guidance ({fda.length})</summary>
                <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4">
                  {fda.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        ) : c.rationale.categories.length > 0 ? (
          <RationaleBadges categories={c.rationale.categories} size="sm" />
        ) : null}

        <Distribution c={c} drafted={drafted} precedents={precedents} />
      </div>
    </article>
  );
}
