"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { getPacket, saveDecision, type DecisionKey, type Packet, type Selection } from "../../lib/api";
import { DECISION_REASONS, encodeReason, parseReason, type ReasonKey } from "@/lib/contracts";
import { Failed, Frame } from "../components/Frame";

type PacketItem = Packet["items"][number];

const NOTE_MAX = 900;

// Three equal-weight choices: nothing is preselected unless the packet already holds a decision, so the tool never nudges.
const CHOICES: { key: DecisionKey; label: string }[] = [
  { key: "needs_medical_review", label: "Needs medical review" },
  { key: "reject", label: "Keep as written" },
  { key: "defer", label: "Needs more information" },
];

// Display labels: the engine's option labels (packet.py) and the reason labels (contracts.ts) are shown in this tab's wording.
const choiceLabel = (key: DecisionKey) =>
  CHOICES.find((c) => c.key === key)?.label ?? (key === "accept" ? "Accept suggested action" : key);
const REASON_LABELS: Partial<Record<ReasonKey, string>> = { prior_evidence: "Prior trial data" };
const reasonLabel = (key: ReasonKey) => REASON_LABELS[key] ?? DECISION_REASONS.find((r) => r.key === key)?.label ?? key;

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

function SavedLine({ item }: { item: PacketItem | undefined }) {
  if (!item?.decision) return <p className="text-base text-muted">No decision recorded yet.</p>;
  const { decision, reviewer, recorded_at, reason } = item.decision;
  const parsed = parseReason(reason);
  const reasonText = parsed.key ? reasonLabel(parsed.key) : null;
  return (
    <div data-testid="saved-decision" className="flex flex-col gap-1">
      <p className="text-base text-ink">
        {item.requirement.label} {item.requirement.threshold}: <span className="font-semibold">{choiceLabel(decision)}</span>, {reviewer},{" "}
        <span className="tabular-nums">{recorded_at}</span>
      </p>
      <p className="text-ink">
        {reasonText ? (
          <>
            Reason: <span className="font-medium">{reasonText}</span>
          </>
        ) : parsed.note ? null : (
          <span className="text-muted">No reason given</span>
        )}
        {parsed.note ? <span className="text-muted">{reasonText ? " / " : ""}Note: {parsed.note}</span> : null}
      </p>
      <p className="text-sm text-muted">Saved in the review packet.</p>
    </div>
  );
}

// `detailed` is the app's Decide tab, which adds the packet export.
export default function Screen7({ nct, criterionId, detailed = false }: Selection & { detailed?: boolean }) {
  const [packet, setPacket] = useState<Packet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The team's pick in this session; until then the saved decision (if any) is shown as selected.
  const [picked, setPicked] = useState<DecisionKey | null>(null);
  const [reason, setReason] = useState<ReasonKey | null>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);

  const refresh = useCallback(
    () =>
      getPacket(nct).then(setPacket, (err: unknown) => {
        console.error(err);
        setError(err instanceof Error ? err.message : String(err));
      }),
    [nct],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const item = packet?.items.find((entry) => entry.criterion_id === criterionId);
  const noteRequired = reason === "other";
  const saved = item?.decision?.decision ?? null;
  const selected = picked ?? (saved && CHOICES.some((c) => c.key === saved) ? saved : null);
  const focusIndex = Math.max(0, CHOICES.findIndex((c) => c.key === selected));

  const save = async () => {
    if (!selected) return;
    if (noteRequired && !note.trim()) {
      setNoteError(true);
      noteRef.current?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const text = reason ? encodeReason(reason, note) : note.trim();
      await saveDecision(nct, criterionId, selected, text, "Demo reviewer");
      await refresh();
    } catch (err: unknown) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // Radio-group keys: arrows move the selection and focus, as in a native radio group.
  const onRadioKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = CHOICES.length - 1;
    const to =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? (index + 1) % CHOICES.length
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? (index + last) % CHOICES.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (to === null) return;
    e.preventDefault();
    setPicked(CHOICES[to].key);
    radios.current[to]?.focus();
  };

  // "Accept suggested action" is an engine option the tab does not offer; it is listed only if a stored decision uses it.
  const details = packet ? (
    <p className="tabular-nums">
      {Object.entries(packet.decision_summary)
        .filter(([key, count]) => key !== "accept" || count > 0)
        .map(([key, count]) => `${choiceLabel(key as DecisionKey)}: ${count}`)
        .join(" · ")}
    </p>
  ) : undefined;

  const app = detailed;
  const headline = app ? (item ? `Decision for ${item.requirement.label} ${item.requirement.threshold}` : "Decision") : "The team decides.";

  return (
    <Frame variant={app ? "app" : "tour"} headline={headline} caption="ProtocolOS prepares the rationale; the team decides." details={details}>
      <div className="flex w-full max-w-3xl flex-col gap-8">
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-medium text-ink">Reason for the decision</legend>
          <div className="flex flex-wrap gap-2">
            {DECISION_REASONS.map((r) => {
              const on = reason === r.key;
              return (
                <button
                  key={r.key}
                  type="button"
                  data-testid={`reason-${r.key}`}
                  aria-pressed={on}
                  onClick={() => {
                    setReason(on ? null : r.key);
                    setNoteError(false);
                  }}
                  className={`min-h-11 rounded-full border px-4 py-2 text-sm transition-colors duration-150 sm:min-h-0 ${focusRing} ${
                    on ? "border-ink bg-ink text-paper" : "border-uncounted bg-paper text-ink hover:border-ink"
                  }`}
                >
                  {reasonLabel(r.key)}
                </button>
              );
            })}
          </div>
          <label htmlFor="decision-note" className="mt-2 text-sm text-ink">
            Note (saved in the review packet)
            {noteRequired ? <span className="text-muted"> - required for Other</span> : <span className="text-muted"> - optional</span>}
          </label>
          <textarea
            ref={noteRef}
            id="decision-note"
            data-testid="decision-note"
            rows={2}
            maxLength={NOTE_MAX}
            required={noteRequired}
            aria-invalid={noteError || undefined}
            aria-describedby="decision-note-help"
            value={note}
            onChange={(e) => {
              setNote(e.target.value.slice(0, NOTE_MAX));
              if (e.target.value.trim()) setNoteError(false);
            }}
            className={`rounded-md border bg-paper px-3 py-2 text-ink ${focusRing} ${noteError ? "border-verdict" : "border-uncounted"}`}
          />
          <p id="decision-note-help" className={`text-sm ${noteError ? "text-verdict" : "text-muted"}`}>
            {noteError ? "Add a note to explain Other. " : null}
            <span className="tabular-nums">
              {note.length}/{NOTE_MAX}
            </span>
          </p>
        </fieldset>
        <div className="flex flex-col gap-3">
          <p id="decision-label" className="text-sm font-medium text-ink">
            Decision
          </p>
          <div role="radiogroup" aria-labelledby="decision-label" className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3">
            {CHOICES.map((choice, index) => {
              const on = selected === choice.key;
              return (
                <button
                  key={choice.key}
                  ref={(el) => {
                    radios.current[index] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  tabIndex={index === focusIndex ? 0 : -1}
                  data-testid={`decide-${choice.key}`}
                  disabled={saving}
                  onClick={() => setPicked(choice.key)}
                  onKeyDown={(e) => onRadioKey(e, index)}
                  className={`flex w-full items-center gap-3 rounded-md border px-4 py-3 text-left text-base transition-colors duration-150 sm:w-auto ${focusRing} disabled:opacity-60 ${
                    on ? "border-ink bg-white text-ink ring-1 ring-ink" : "border-uncounted bg-paper text-ink hover:border-ink"
                  }`}
                >
                  <span aria-hidden className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${on ? "border-ink" : "border-uncounted"}`}>
                    {on ? <span className="h-2 w-2 rounded-full bg-ink" /> : null}
                  </span>
                  {choice.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            data-testid="save-decision"
            disabled={!selected || saving}
            onClick={() => void save()}
            className={`w-full rounded-md border border-ink bg-ink px-5 py-3 text-base text-paper transition-opacity duration-150 disabled:opacity-40 sm:w-auto sm:self-start ${focusRing}`}
          >
            {saving ? "Saving…" : "Save decision"}
          </button>
        </div>
        <div aria-live="polite">
          {error ? (
            <Failed message={error} action={packet ? "save the decision" : "load the review packet"} />
          ) : packet ? (
            <SavedLine item={item} />
          ) : (
            <p className="text-base text-muted">Loading the review packet…</p>
          )}
        </div>
        {detailed ? (
          <a
            href={`/api/packet/${encodeURIComponent(nct)}?format=md`}
            data-testid="export-packet"
            className={`self-start rounded-md border border-ink px-5 py-2 text-ink transition-colors duration-150 hover:bg-line ${focusRing}`}
          >
            Export review packet
          </a>
        ) : null}
      </div>
    </Frame>
  );
}
