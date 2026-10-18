"use client";

import { useEffect, useState } from "react";
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

export default function Screen7({ nct, criterionId }: Selection) {
  const [packet, setPacket] = useState<Packet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<DecisionKey | null>(null);

  const refresh = () =>
    getPacket(nct).then(setPacket, (err: unknown) => {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    });

  useEffect(() => {
    void refresh();
  }, []);

  const decide = async (key: DecisionKey) => {
    setSaving(key);
    setError(null);
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
  const details = packet ? (
    <p className="tabular-nums">
      {Object.entries(packet.decision_summary)
        .map(([key, count]) => `${key.replaceAll("_", " ")}: ${count}`)
        .join(" / ")}
    </p>
  ) : undefined;

  return (
    <Frame headline="The team decides." caption="TrialLens prepares the evidence; people decide." details={details}>
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
      </div>
    </Frame>
  );
}
