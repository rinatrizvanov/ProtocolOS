"use client";

import { useCallback, useEffect, useState } from "react";
import { getPacket, saveDecision, type DecisionKey, type Packet, type Selection } from "../../lib/api";
import { DECISION_REASONS, encodeReason, parseReason, type ReasonKey } from "@/lib/contracts";
import { Failed, Frame } from "../components/Frame";

type PacketItem = Packet["items"][number];

const NOTE_MAX = 900;

const CHOICES: { key: DecisionKey; label: string; primary: boolean }[] = [
  { key: "needs_medical_review", label: "Needs medical review", primary: true },
  { key: "reject", label: "Keep as written", primary: false },
  { key: "defer", label: "Needs more information", primary: false },
];

// Display labels: the engine's option labels (packet.py) and the reason labels (contracts.ts) are shown in this tab's wording.
const choiceLabel = (key: DecisionKey) =>
  CHOICES.find((c) => c.key === key)?.label ?? (key === "accept" ? "Accept suggested action" : key);
const REASON_LABELS: Partial<Record<ReasonKey, string>> = { prior_evidence: "Prior trial data" };
const reasonLabel = (key: ReasonKey) => REASON_LABELS[key] ?? DECISION_REASONS.find((r) => r.key === key)?.label ?? key;

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

function SavedLine({ item }: { item: PacketItem | undefined }) {
  if (!item?.decision) return <p className="text-lg text-muted">No decision recorded yet.</p>;
  const { decision, reviewer, recorded_at, reason } = item.decision;
  const parsed = parseReason(reason);
  const reasonText = parsed.key ? reasonLabel(parsed.key) : null;
  return (
    <div data-testid="saved-decision" className="flex flex-col gap-1">
      <p className="text-lg text-ink">
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
  const [saving, setSaving] = useState<DecisionKey | null>(null);
  const [reason, setReason] = useState<ReasonKey | null>(null);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState(false);

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

  const decide = async (key: DecisionKey) => {
    if (noteRequired && !note.trim()) {
      setNoteError(true);
      return;
    }
    setSaving(key);
    setError(null);
    try {
      const text = reason ? encodeReason(reason, note) : note.trim();
      await saveDecision(nct, criterionId, key, text, "Demo reviewer");
      await refresh();
    } catch (err: unknown) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  const details = packet ? (
    <p className="tabular-nums">
      {Object.entries(packet.decision_summary)
        .map(([key, count]) => `${choiceLabel(key as DecisionKey)}: ${count}`)
        .join(" / ")}
    </p>
  ) : undefined;

  return (
    <Frame headline="The team decides." caption="ProtocolOS prepares the rationale; the team decides." details={details}>
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
                  className={`rounded-full border px-4 py-2 text-sm transition-colors duration-150 ${focusRing} ${
                    on ? "border-ink bg-ink text-paper" : "border-line bg-paper text-ink hover:border-ink"
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
            className={`rounded-md border bg-paper px-3 py-2 text-ink ${focusRing} ${noteError ? "border-verdict" : "border-line"}`}
          />
          <p id="decision-note-help" className={`text-sm ${noteError ? "text-verdict" : "text-muted"}`}>
            {noteError ? "Add a note to explain Other. " : null}
            <span className="tabular-nums">
              {note.length}/{NOTE_MAX}
            </span>
          </p>
        </fieldset>
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-ink">Decision</p>
          <div className="flex flex-wrap gap-4">
            {CHOICES.map((choice) => (
              <button
                key={choice.key}
                type="button"
                data-testid={`decide-${choice.key}`}
                disabled={saving !== null}
                onClick={() => void decide(choice.key)}
                className={`rounded-md border px-6 py-4 text-lg transition-colors duration-150 ${focusRing} disabled:opacity-60 ${
                  choice.primary ? "border-ink bg-ink text-paper" : "border-line bg-paper text-ink hover:border-ink"
                }`}
              >
                {saving === choice.key ? "Saving…" : choice.label}
              </button>
            ))}
          </div>
        </div>
        <div aria-live="polite">
          {error ? <Failed message={error} /> : packet ? <SavedLine item={item} /> : <p className="text-lg text-muted">Loading packet</p>}
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
