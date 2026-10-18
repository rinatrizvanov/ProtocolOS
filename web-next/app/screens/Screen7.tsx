"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getPacket, saveDecision, type DecisionKey, type Packet, type Selection } from "../../lib/api";
import { Failed, Frame } from "../components/Frame";

type PacketItem = Packet["items"][number];

const CHOICES: { key: DecisionKey; label: string; primary: boolean }[] = [
  { key: "needs_medical_review", label: "Needs medical review", primary: true },
  { key: "reject", label: "Keep as written", primary: false },
  { key: "defer", label: "Need more evidence", primary: false },
];

function SavedLine({ item }: { item: PacketItem | undefined }) {
  if (!item?.decision) return <p className="text-lg text-muted">No decision recorded yet.</p>;
  const { label, reviewer, recorded_at } = item.decision;
  return (
    <p data-testid="saved-decision" className="text-lg text-ink">
      {item.requirement.label} {item.requirement.threshold}: <span className="font-semibold">{label}</span>, {reviewer}, {recorded_at}
    </p>
  );
}

// `detailed` is the app's Decide tab, which adds the packet export.
export default function Screen7({ nct, criterionId, detailed = false }: Selection & { detailed?: boolean }) {
  const [packet, setPacket] = useState<Packet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<DecisionKey | null>(null);

  const [comment, setComment] = useState("");
  const [submitted, setSubmitted] = useState(false);

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

  const decide = async (key: DecisionKey) => {
    setSaving(key);
    setError(null);
    setSubmitted(false);
    try {
      await saveDecision(nct, criterionId, key, "Recorded from the demo", "Demo reviewer");
      await refresh();
    } catch (err: unknown) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(null);
    }
  };

  const item = packet?.items.find((entry) => entry.criterion_id === criterionId);

  // The comment rides on the decision already recorded: it is re-saved as that decision's reason.
  const submitFeedback = async (e: FormEvent) => {
    e.preventDefault();
    const current = item?.decision;
    const text = comment.trim();
    if (!current || !text) return;
    setSaving(current.decision);
    setError(null);
    try {
      await saveDecision(nct, criterionId, current.decision, text, "Demo reviewer");
      await refresh();
      setComment("");
      setSubmitted(true);
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
        .map(([key, count]) => `${key.replaceAll("_", " ")}: ${count}`)
        .join(" / ")}
    </p>
  ) : undefined;

  return (
    <Frame headline="The team decides." caption="ProtocolOS prepares the rationale; the team decides." details={details}>
      <div className="flex w-full max-w-3xl flex-col gap-10">
        <div className="flex flex-wrap gap-4">
          {CHOICES.map((choice) => (
            <button
              key={choice.key}
              type="button"
              data-testid={`decide-${choice.key}`}
              disabled={saving !== null}
              onClick={() => void decide(choice.key)}
              className={`rounded-md border px-6 py-4 text-lg transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:opacity-60 ${
                choice.primary ? "border-ink bg-ink text-paper" : "border-line bg-paper text-ink hover:border-ink"
              }`}
            >
              {saving === choice.key ? "Saving…" : choice.label}
            </button>
          ))}
        </div>
        {error ? <Failed message={error} /> : packet ? <SavedLine item={item} /> : <p className="text-lg text-muted">Loading packet</p>}
        {item?.decision ? (
          <form onSubmit={submitFeedback} className="flex flex-col gap-2">
            <label htmlFor="feedback" className="text-sm text-ink">
              Comment for ProtocolOS
            </label>
            <textarea
              id="feedback"
              data-testid="feedback-input"
              rows={3}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Why this decision? What did ProtocolOS miss?"
              className="rounded-md border border-line bg-paper px-3 py-2 text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
            />
            <button
              type="submit"
              data-testid="feedback-submit"
              disabled={!comment.trim() || saving !== null}
              className="self-start rounded-md border border-ink px-5 py-2 text-ink transition-colors duration-150 hover:bg-line disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
            >
              Submit
            </button>
          </form>
        ) : null}
        {detailed ? (
          <a
            href={`/api/packet/${encodeURIComponent(nct)}?format=md`}
            data-testid="export-packet"
            className="self-start rounded-md border border-ink px-5 py-2 text-ink transition-colors duration-150 hover:bg-line focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            Export review packet
          </a>
        ) : null}
        <div aria-live="polite">
          {submitted && item?.decision ? (
            <div data-testid="feedback-submitted" className="flex flex-col gap-1">
              <p className="font-medium text-support">Saved with the decision</p>
              <p className="text-ink">&ldquo;{item.decision.reason}&rdquo; ({item.decision.recorded_at})</p>
              <p className="text-sm text-muted">Stored in the review packet.</p>
            </div>
          ) : null}
        </div>
      </div>
    </Frame>
  );
}
