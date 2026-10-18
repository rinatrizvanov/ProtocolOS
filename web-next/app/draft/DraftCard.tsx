import { useState, type ReactNode } from "react";
import type { DraftCriterion, Precedent, PrecedentValue } from "@/lib/contracts";
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
// Agreement among precedents is a count, not an approval, so it gets an equals sign rather than a check mark.
const EQUALS = "M3.5 6h9M3.5 10h9";
export const CHEVRON = "M4 6l4 4 4-4";

// The self-critique as /draft shows it. The engine classification is kept on data-classification; this splits it by
// whether a value was proposed, and names "Evidence supports retaining" for what it is on a new draft: the value is
// the precedents' mode, so the precedents that agree with it include the one it was copied from.
export type Bucket = "review" | "insufficient_value" | "insufficient" | "agree";
export const BUCKET: Record<Bucket, { label: string; icon: string; chip: string; tone: string }> = {
  review: { label: "Review recommended", icon: WARN, chip: "bg-look-soft", tone: "text-look" },
  insufficient_value: { label: "Insufficient evidence for this value", icon: QUESTION, chip: "bg-uncounted-soft", tone: "text-muted" },
  insufficient: { label: "Insufficient evidence", icon: QUESTION, chip: "bg-uncounted-soft", tone: "text-muted" },
  agree: { label: "Precedents agree (may be carry-forward)", icon: EQUALS, chip: "bg-support-soft", tone: "text-support" },
};
// Verdict order on the page: what needs a look first, what agrees with the precedents last.
export const BUCKET_ORDER: Bucket[] = ["review", "insufficient_value", "insufficient", "agree"];

export function bucketOf(c: DraftCriterion): Bucket {
  // With no value proposed there is nothing to critique but the gap itself: Insufficient evidence.
  if (c.status !== "drafted" || c.proposed === null) return "insufficient";
  if (c.critique.classification === "Review recommended") return "review";
  // A drafted value can get this verdict: a precedent used it, but nothing explains this exact value.
  if (c.critique.classification === "Insufficient evidence") return "insufficient_value";
  return "agree";
}

export const verdictLabel = (c: DraftCriterion): string => BUCKET[bucketOf(c)].label;

// Review recommended cards and drafted values without a rationale start open; the rest are one compact row.
export const opensByDefault = (c: DraftCriterion): boolean => {
  const b = bucketOf(c);
  return b === "review" || b === "insufficient_value";
};

function VerdictChip({ c }: { c: DraftCriterion }) {
  const v = BUCKET[bucketOf(c)];
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

// "≤1", not "≤1 ECOG": the unit is left out when it is the scale's name or already part of the label.
export function shownUnit(unit: string, label: string): string {
  if (!unit || unit === "ECOG" || label.toLowerCase().includes(unit.toLowerCase())) return "";
  return unit;
}
export function valueText(operator: string, value: number, unit: string, label: string): string {
  const u = shownUnit(unit, label);
  return `${operator}${fmt(value)}${u ? ` ${u}` : ""}`;
}

// The extractor keeps the threshold and drops the words around it. When the source wording adds a condition
// (a dose, an alternative criterion, a subgroup), the value alone is not the whole criterion. A backend field wins;
// until it exists, the quote is searched for the usual markers. Lowercase "or" is left out: "or ≥5.6 mmol/L" is a unit.
const CONDITION = /\b(if|unless|for (subjects|patients|participants) with|Gy|half-lives|transfusions?|whichever)\b/i;
export function hasCondition(quote: string | null | undefined, field?: string | null): boolean {
  if (field) return true;
  if (!quote) return false;
  return CONDITION.test(quote) || /\bOR\b/.test(quote);
}
export function draftHasCondition(c: DraftCriterion): boolean {
  if (!c.proposed) return false;
  const field = (c.proposed as { qualifier?: string | null }).qualifier;
  return hasCondition(sourceOf(c)?.quote, field);
}

export function ConditionMark({ short = false }: { short?: boolean }) {
  return (
    <span
      data-role="condition"
      title="The source wording adds a condition to this value; read the quote."
      className="inline-flex items-center whitespace-nowrap rounded bg-look-soft px-1.5 py-px text-xs font-medium text-ink ring-1 ring-look/50 ring-inset"
    >
      {short ? "+ condition" : "+ condition in source, see quote"}
    </span>
  );
}

export function sourceOf(c: DraftCriterion): PrecedentValue | undefined {
  return c.proposed ? c.rationale.precedents.find((p) => p.nct_id === c.proposed?.source_nct_id) : undefined;
}

// Engine prose, tidied for display only: "ECOG ≤1" instead of "≤1 ECOG" ("performance status ≤1" keeps no unit);
// and a new draft has nothing to keep unchanged, so the retain action's "No change suggested." is dropped.
export function tidy(text: string): string {
  return text
    .replace(/(performance status [≤≥<>]=?\s?\d+(?:\.\d+)?) ECOG\b/gi, "$1")
    // A number that is part of an id ("NCT02220894 ECOG performance status") is left alone.
    .replace(/(?<![\w.])((?:[≤≥<>]=?\s?)?\d+(?:\.\d+)?) ECOG\b/g, "ECOG $1")
    .replace(/^No change suggested\.\s*/, "");
}

const year = (s: Precedent | undefined) => (s?.start_date ? s.start_date.slice(0, 4) : null);

function pageHref(p: { url: string | null; page: number | null }): string | null {
  if (!p.url) return null;
  return p.page ? `${p.url}#page=${p.page}` : p.url;
}

const CONNECTOR = /^(or|and|nor|but|the|a|an|of|to|in|on|at|by|for|with|than|that|if|unless|who|which)$/i;
const WORD = /^[A-Za-z][A-Za-z-]*$/;

// Precedent quotes are verbatim protocol text cut at a line or table-cell edge; an ellipsis marks where a sentence
// was cut, and runs of table spacing collapse to one space. A list marker ("5.", "e.", "c)") is a real start.
export function excerpt(raw: string): string {
  let q = raw.replace(/\s+/g, " ").trim();
  const listStart = /^(\d+|[a-z])[.)]\s/.test(q);
  const lead = !listStart && (/^[a-z]{2,}/.test(q) || /^\d/.test(q)) ? "…" : "";
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

const LINK = "underline decoration-line underline-offset-2 hover:text-ink hover:decoration-ink";
// Padding that makes a short inline link a usable tap target without moving the text around it.
const TAP = "-mx-1 -my-1 inline-block rounded px-1 py-1";

function TrialLink({ p, precedents, children }: { p: PrecedentValue; precedents: Map<string, Precedent>; children: ReactNode }) {
  const href = pageHref(p);
  const study = precedents.get(p.nct_id);
  const hint = study ? `${study.title}${study.start_date ? ` (started ${study.start_date})` : ""}` : undefined;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" title={hint} className={`${LINK} ${TAP}`}>
      {children}
    </a>
  ) : (
    <span title={hint}>{children}</span>
  );
}

// One bar per distinct precedent value; each trial id links to the protocol page the verifier matched, with the
// trial's start year inline (the registry title stays a tooltip).
function Distribution({ c, drafted, precedents }: { c: DraftCriterion; drafted: boolean; precedents: Map<string, Precedent> }) {
  if (c.distribution.length === 0) return null;
  const total = c.distribution.reduce((s, d) => s + d.count, 0) || 1;
  const byNct = new Map(c.rationale.precedents.map((p) => [p.nct_id, p]));
  return (
    <div data-testid="draft-distribution" className="flex flex-col gap-1.5">
      <h4 className="text-xs font-medium text-muted">
        {drafted ? "What regimen-matched precedents used" : "Values in matched trials (context only, no value proposed)"}
      </h4>
      <ul className="flex flex-col gap-2">
        {c.distribution.map((d) => {
          const chosen = c.proposed !== null && d.operator === c.proposed.operator && d.value === c.proposed.value;
          return (
            <li key={`${d.operator}${d.value}${d.unit}`} className="grid grid-cols-[5.5rem_1fr] items-start gap-2 text-[13px] sm:grid-cols-[6.5rem_1fr]">
              <span className={`tabular-nums ${chosen ? "font-semibold text-ink" : "text-muted"}`}>{valueText(d.operator, d.value, d.unit, c.label)}</span>
              <div className="flex min-w-0 flex-col gap-1 pt-1.5">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 rounded-sm bg-uncounted-soft">
                    <div className={`h-1.5 rounded-sm ${chosen ? "bg-ink" : "bg-uncounted"}`} style={{ width: `${(d.count / total) * 100}%` }} />
                  </div>
                  <span className="w-6 text-right tabular-nums text-muted">{d.count}×</span>
                </div>
                <span className="flex flex-wrap gap-x-3 text-muted">
                  {d.nct_ids.map((n) => {
                    const p = byNct.get(n);
                    const y = year(precedents.get(n));
                    if (!p) return <span key={n}>{n}</span>;
                    return (
                      <span key={n} className="whitespace-nowrap">
                        <TrialLink p={p} precedents={precedents}>
                          {p.acronym ?? n}
                          {p.page ? ` p.${p.page}` : ""}
                        </TrialLink>
                        {y ? <span className="tabular-nums"> · {y}</span> : null}
                      </span>
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

// The verifier's check ids, as a short name for the summary and a reader-facing name for the grouped list.
const CHECK_NAMES: Record<string, { short: string; long: string }> = {
  comparator_value: { short: "Precedent values", long: "Precedent values match their protocols" },
  fda_quote: { short: "FDA quotes", long: "FDA quotes found verbatim" },
  drug_property: { short: "Drug properties", long: "Drug properties match the curated drug table" },
  criterion_exists: { short: "Criterion", long: "Criterion identified" },
  plausibility: { short: "Plausible range", long: "Value in a plausible range" },
};
const CHECK_ORDER = ["comparator_value", "fda_quote", "drug_property", "criterion_exists", "plausibility"];
const checkName = (id: string) => CHECK_NAMES[id] ?? { short: id.replaceAll("_", " "), long: id.replaceAll("_", " ") };

function checkDetail(detail: string): string {
  // The curated pharmacology table reports properties as flags: "carboplatin myelosuppressive=True is consistent ...".
  const consistent = /^(.+?) ([a-z_]+)=(True|False) is consistent with the curated table\.$/.exec(detail);
  const text = consistent
    ? `${consistent[1]}: ${consistent[3] === "True" ? "" : "not "}${consistent[2].replaceAll("_", " ")}, as in the curated drug table.`
    : detail.replace(/\b([a-z_]+)=(True|False)\b/g, (_, p: string, v: string) => `${p.replaceAll("_", " ")}: ${v === "True" ? "yes" : "no"}`);
  // "100.0 ×10⁹/L" and "≥28.0 days" read as 100 and 28.
  return tidy(text.replace(/(\d)\.0\b/g, "$1"));
}

type Verification = NonNullable<DraftCriterion["verification"]>;

function statusLook(v: Verification) {
  const icon = v.status === "PASSED" ? CHECK : v.status === "REJECTED" ? CROSS : WARN;
  // Amber is too light for text, so a warning keeps the label in ink and puts the hue on the icon only.
  const tone = v.status === "PASSED" ? "text-support" : v.status === "REJECTED" ? "text-verdict" : "text-look";
  const labelTone = v.status === "PASSED_WITH_WARNINGS" ? "text-ink" : tone;
  const label = v.status === "PASSED" ? "Verifier passed" : v.status === "REJECTED" ? "Verifier rejected" : "Verifier passed with warnings";
  return { icon, tone, labelTone, label };
}

function VerifierStatus({ c }: { c: DraftCriterion }) {
  const v = c.verification;
  if (!v) return null;
  const { icon, tone, labelTone, label } = statusLook(v);
  return (
    <span data-testid="draft-checks" data-status={v.status} className={`inline-flex items-center gap-1 font-medium ${labelTone}`}>
      <Icon d={icon} className={tone} />
      {label}
      <span className="font-normal tabular-nums text-muted">
        {" "}
        · {v.checks.length} check{v.checks.length === 1 ? "" : "s"}
      </span>
    </span>
  );
}

// The full check list, grouped by check type; the summary counts each type instead of repeating every row.
function CheckList({ c }: { c: DraftCriterion }) {
  const v = c.verification;
  if (!v) {
    return (
      <p data-testid="draft-checks" data-status="NOT_RUN" className="text-[13px] text-muted">
        Verifier not run: no value was proposed.
      </p>
    );
  }
  const ids = [...new Set(v.checks.map((k) => k.check))].sort((a, b) => {
    const ia = CHECK_ORDER.indexOf(a);
    const ib = CHECK_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const groups = ids.map((id) => {
    const rows = v.checks.filter((k) => k.check === id);
    return { id, rows, pass: rows.filter((k) => k.result === "pass").length, warn: rows.filter((k) => k.result === "warn").length, fail: rows.filter((k) => k.result === "fail").length };
  });
  return (
    <details className="group text-[13px]">
      <summary className="flex min-h-6 cursor-pointer select-none flex-wrap items-center gap-x-2 gap-y-1 rounded py-1 text-muted focus-visible:outline-2 focus-visible:outline-ink">
        <span className="font-medium text-ink">Checks</span>
        {groups.map((g, i) => (
          <span key={g.id} className="tabular-nums">
            {i > 0 ? "· " : ""}
            {checkName(g.id).short} {g.pass}/{g.rows.length}
            {g.warn ? ` (${g.warn} warn)` : ""}
            {g.fail ? ` (${g.fail} fail)` : ""}
          </span>
        ))}
        <span className="underline decoration-line underline-offset-2 group-open:hidden">show checks</span>
        <span className="hidden underline decoration-line underline-offset-2 group-open:inline">hide checks</span>
      </summary>
      <div className="mt-1.5 flex flex-col gap-2.5 border-l border-line pl-3">
        {groups.map((g) => (
          <div key={g.id} className="flex flex-col gap-1">
            <p className="font-medium text-ink">
              {checkName(g.id).long}{" "}
              <span className="font-normal tabular-nums text-muted">
                ({g.pass} of {g.rows.length} passed)
              </span>
            </p>
            <ul className="flex flex-col gap-0.5">
              {g.rows.map((k, i) => (
                <li key={i} className="flex gap-1.5 text-muted">
                  <Icon d={k.result === "pass" ? CHECK : k.result === "warn" ? WARN : CROSS} className={`mt-0.5 ${k.result === "pass" ? "text-support" : k.result === "warn" ? "text-look" : "text-verdict"}`} />
                  <span>{checkDetail(k.detail)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
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

type Fda = DraftCriterion["rationale"]["fda"][number];
const fdaRank = (f: Fda) => (f.stance === "challenges" ? 2 : 0) + (f.specific ? 1 : 0);

// FDA passages carry a stance; most of them argue for broader criteria, so they are listed as guidance to weigh,
// never as reasons for the value. Challenging and criterion-specific passages come first.
function FdaGuidance({ c, drafted }: { c: DraftCriterion; drafted: boolean }) {
  const items = [...c.rationale.fda].sort((a, b) => fdaRank(b) - fdaRank(a));
  if (items.length === 0) return null;
  const challenging = items.filter((f) => f.stance === "challenges").length;
  const target = drafted ? "this value" : "such a criterion";
  return (
    <details data-testid="draft-fda" className="group text-[13px]">
      <summary className="min-h-6 cursor-pointer select-none rounded py-1 text-muted focus-visible:outline-2 focus-visible:outline-ink">
        <span className="font-medium text-ink">FDA guidance to weigh ({items.length})</span>
        {challenging ? (
          <span>
            {" "}
            · {challenging} challenge{challenging === 1 ? "s" : ""} {target}
          </span>
        ) : null}
      </summary>
      <ul className="mt-2 flex flex-col gap-3 border-l border-line pl-3">
        {items.map((f) => (
          <li key={f.key} data-stance={f.stance} className="flex flex-col gap-1">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
              {f.stance === "challenges" ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-look-soft px-2 py-0.5 font-medium text-ink">
                  <Icon d={WARN} className="text-look" />
                  Challenges {target}
                </span>
              ) : (
                <span className="inline-flex items-center rounded-full bg-uncounted-soft px-2 py-0.5 font-medium text-ink">Context</span>
              )}
              <span className="text-muted">{f.specific ? "specific to this criterion" : "general"}</span>
            </span>
            <q data-role="quote" className="text-ink">
              {f.quote}
            </q>
            <a href={f.link} target="_blank" rel="noreferrer" className={`self-start text-xs text-muted ${LINK}`}>
              {f.citation}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}

// /draft passes open and onToggle and keeps every card's state; the guided tour passes neither, and the card then starts
// open and keeps its own toggle state, which resets when another criterion is shown in the same place.
export default function DraftCard({
  c,
  precedents,
  open,
  onToggle,
}: {
  c: DraftCriterion;
  precedents: Map<string, Precedent>;
  open?: boolean;
  onToggle?: () => void;
}) {
  const [own, setOwn] = useState<{ id: string; open: boolean } | null>(null);
  const isOpen = onToggle ? (open ?? true) : own?.id === c.id ? own.open : (open ?? true);
  const toggle = onToggle ?? (() => setOwn({ id: c.id, open: !isOpen }));
  const cls = c.critique.classification;
  const bucket = bucketOf(c);
  const drafted = c.status === "drafted" && c.proposed !== null;
  // FDA lines go to their own block with their stance; the last line repeats the self-critique.
  const why = c.why_generated
    .filter((w) => !w.startsWith("Self-critique:") && !w.startsWith("FDA:"))
    // With no value proposed, the safety line's "not this value" has nothing to point at.
    .map((w) => tidy(drafted ? w : w.replace(/, not this value\.$/, ", not a specific value.")));
  // The explanation starts with the engine label the verdict chip shows, and ends with the internal score tally.
  const body = (c.critique.explanation.startsWith(`${cls}: `) ? c.critique.explanation.slice(cls.length + 2) : c.critique.explanation).replace(
    /\s*\(support score \d+, challenge score \d+\)\.?$/,
    "",
  );
  // On an insufficient card the reason is already stated under the heading, so the critique does not repeat it.
  const reason = drafted ? null : c.insufficient_reason;
  const explanation = reason && body.includes(reason) ? null : tidy(body.charAt(0).toUpperCase() + body.slice(1));
  const next = tidy(c.critique.suggested_action.text);
  const missing = c.critique.missing_evidence.filter((m) => m !== reason).map(tidy);
  const source = sourceOf(c);
  const sourceCount = c.proposed ? (c.distribution.find((d) => d.operator === c.proposed?.operator && d.value === c.proposed?.value)?.count ?? 1) : 0;
  const sourceName = source ? `${source.acronym ?? source.nct_id}${source.page ? ` p.${source.page}` : ""}` : (c.proposed?.source_nct_id ?? "");
  const sourceYear = year(precedents.get(c.proposed?.source_nct_id ?? ""));
  const bodyId = `draft-${c.id}-body`;

  return (
    <article
      id={`draft-${c.id}`}
      data-testid="draft-criterion"
      data-status={c.status}
      data-analyte={c.analyte}
      data-bucket={bucket}
      data-open={isOpen}
      className="scroll-mt-4 rounded-lg border border-line bg-white"
    >
      <div className="flex flex-col gap-2.5 p-4">
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <h3 className="text-base font-semibold text-ink">{c.label}</h3>
            <span className="text-xs text-muted">{c.section === "exclusion" ? "Exclusion" : "Inclusion"}</span>
          </div>
          <VerdictChip c={c} />
        </header>

        {drafted && c.proposed ? (
          <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[11rem_1fr]">
            <div className="flex flex-col items-start gap-1">
              <p data-testid="draft-value" className="text-2xl font-semibold leading-tight tabular-nums tracking-tight text-ink">
                {c.proposed.operator}
                {fmt(c.proposed.value)}
                {shownUnit(c.proposed.unit, c.label) ? <span className="text-base font-medium text-muted"> {shownUnit(c.proposed.unit, c.label)}</span> : null}
              </p>
              {draftHasCondition(c) ? <ConditionMark /> : null}
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              {source && source.quote.trim() ? (
                <blockquote data-testid="draft-quote" data-role="quote" className="border-l-2 border-line pl-3 text-[13px] leading-snug">
                  <span className="text-ink">“{excerpt(source.quote)}”</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    As worded in{" "}
                    <TrialLink p={source} precedents={precedents}>
                      {sourceName}
                    </TrialLink>
                    {sourceYear ? <span className="tabular-nums"> · started {sourceYear}</span> : null}
                  </span>
                </blockquote>
              ) : null}
              {bucket === "insufficient_value" ? (
                <p data-testid="draft-value-note" className="text-[13px] leading-snug text-ink">
                  Value taken from {sourceName} ({sourceCount} matched precedent{sourceCount === 1 ? "" : "s"} used it); no rationale for this exact value was
                  found, so treat it as a review question.
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <p data-testid="draft-insufficient" className="rounded-md bg-uncounted-soft px-3 py-2 text-sm text-ink">
            No value proposed. {c.insufficient_reason ?? "No regimen-matched precedent the verifier could match."}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <VerifierStatus c={c} />
            {drafted && c.rationale.carry_forward && bucket !== "agree" ? (
              <span className="inline-flex items-center gap-1 text-muted" title="All precedents agree; agreement may reflect template carry-forward.">
                <Icon d={EQUALS} />
                may be carry-forward
              </span>
            ) : null}
          </div>
          <button
            type="button"
            data-testid="draft-toggle"
            aria-expanded={isOpen}
            aria-controls={bodyId}
            onClick={toggle}
            className="-my-1 inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-[13px] font-medium text-ink hover:bg-uncounted-soft focus-visible:outline-2 focus-visible:outline-ink"
          >
            {isOpen ? "Hide reasoning" : "Show reasoning"}
            <Icon d={CHEVRON} className={`transition-transform duration-150 ${isOpen ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      <div id={bodyId} hidden={!isOpen} className="grid grid-cols-1 gap-x-8 gap-y-4 border-t border-line px-4 pb-4 pt-3 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <section data-testid="draft-critique" data-classification={cls} className="flex flex-col gap-1.5 rounded-md bg-paper px-3 py-2.5 text-sm">
            <h4 className="text-xs font-medium text-muted">Self-critique</h4>
            {explanation ? <p className="text-ink">{explanation}</p> : null}
            {next ? (
              <p className="text-ink">
                <span className="font-medium">Next:</span> {next}
              </p>
            ) : null}
            {missing.length > 0 ? (
              <details className="text-[13px] text-muted">
                <summary className="min-h-6 cursor-pointer select-none rounded py-1 font-medium focus-visible:outline-2 focus-visible:outline-ink">Not found yet ({missing.length})</summary>
                <ul className="mt-1 list-disc pl-4">
                  {missing.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
          <CheckList c={c} />
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          {why.length > 0 ? (
            <section data-testid="draft-why" className="flex flex-col gap-1.5 text-sm">
              <h4 className="text-xs font-medium text-muted">{drafted ? "Why this value" : "Context"}</h4>
              {c.rationale.categories.length > 0 ? <RationaleBadges categories={c.rationale.categories} size="sm" /> : null}
              <ul className="flex list-disc flex-col gap-1 pl-4 text-[13px] leading-snug text-muted">
                {why.map((w, i) => (
                  <WhyLine key={i} text={w} />
                ))}
              </ul>
            </section>
          ) : c.rationale.categories.length > 0 ? (
            <RationaleBadges categories={c.rationale.categories} size="sm" />
          ) : null}
          <FdaGuidance c={c} drafted={drafted} />
          <Distribution c={c} drafted={drafted} precedents={precedents} />
        </div>
      </div>
    </article>
  );
}
