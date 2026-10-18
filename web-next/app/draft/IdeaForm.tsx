"use client";

import { useState, type FormEvent, type KeyboardEvent } from "react";
import type { DraftVocabulary, Idea, SettingTag } from "@/lib/contracts";

const ALL_SETTINGS: SettingTag[] = ["first-line", "metastatic", "non-squamous", "squamous", "perioperative/locally-advanced"];
const MAX_DRUGS = 8;
const MAX_DRUG_CHARS = 40;

// Matches a typed drug against the vocabulary by name or alias; null when the engine would not recognize it,
// undefined while the vocabulary is loading or could not be loaded.
function lookup(vocab: DraftVocabulary | null, raw: string) {
  const q = raw.trim().toLowerCase();
  if (!vocab) return undefined;
  return vocab.drugs.find((d) => d.name.toLowerCase() === q || d.aliases.some((a) => a.toLowerCase() === q)) ?? null;
}

export default function IdeaForm({
  vocabulary,
  vocabularyFailed,
  busy,
  onSubmit,
}: {
  vocabulary: DraftVocabulary | null;
  vocabularyFailed: boolean;
  busy: boolean;
  onSubmit: (idea: Idea) => void;
}) {
  const [condition, setCondition] = useState("");
  const [drugs, setDrugs] = useState<string[]>([]);
  const [pending, setPending] = useState("");
  const [setting, setSetting] = useState<SettingTag[]>([]);
  const [phase, setPhase] = useState<Idea["phase"]>("PHASE3");
  const [notice, setNotice] = useState<string | null>(null);
  const settings = vocabulary?.settings ?? ALL_SETTINGS;
  const phases = vocabulary?.phases ?? ["PHASE2", "PHASE3"];

  function addDrugs(text: string): string[] {
    const parts = text
      .split(/[,;\n]/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const next = [...drugs];
    const badLength: string[] = [];
    let overflow = 0;
    // The engine accepts 1-8 drugs of 2-40 characters each; anything else is reported here instead of as a 422.
    for (const p of parts) {
      if (next.some((d) => d.toLowerCase() === p.toLowerCase())) continue;
      if (p.length < 2 || p.length > MAX_DRUG_CHARS) badLength.push(p.length > MAX_DRUG_CHARS ? `${p.slice(0, 24)}…` : p);
      else if (next.length >= MAX_DRUGS) overflow += 1;
      else next.push(p);
    }
    const problems = [
      badLength.length ? `each drug name needs 2-${MAX_DRUG_CHARS} characters (${badLength.join(", ")})` : "",
      overflow ? `at most ${MAX_DRUGS} drugs (${overflow} more not added)` : "",
    ].filter(Boolean);
    setNotice(problems.length ? `Not added: ${problems.join("; ")}.` : null);
    setDrugs(next);
    setPending("");
    return next;
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      if (pending.trim()) addDrugs(pending);
    } else if (e.key === "Backspace" && pending === "" && drugs.length > 0) {
      setDrugs(drugs.slice(0, -1));
    }
  }

  // Typed text becomes a chip on Enter, comma or submit, never on blur: a chip added on blur can wrap the regimen box
  // and move the control under the pointer between mousedown and mouseup, so that click would be lost.
  function submit(e: FormEvent) {
    e.preventDefault();
    const all = pending.trim() ? addDrugs(pending) : drugs;
    if (condition.trim().length < 3 || all.length === 0) return;
    onSubmit({ condition: condition.trim(), drugs: all, setting, phase, as_of: null });
  }

  const ready = condition.trim().length >= 3 && (drugs.length > 0 || pending.trim().length > 0);

  return (
    <form data-testid="idea-form" onSubmit={submit} className="flex flex-col gap-3" aria-label="Describe a new trial idea">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium text-ink">Condition</span>
        <input
          data-testid="idea-condition"
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
          placeholder="e.g. non-small cell lung cancer"
          minLength={3}
          maxLength={120}
          className="rounded-md border border-line bg-white px-2.5 py-1.5 text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink/30"
        />
      </label>

      <div className="flex flex-col gap-1 text-sm">
        <label htmlFor="idea-drugs" className="font-medium text-ink">
          Regimen <span className="font-normal text-muted">(press Enter after each drug)</span>
        </label>
        <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-line bg-white px-2 py-1.5 focus-within:ring-2 focus-within:ring-ink/30">
          {drugs.map((d) => {
            const hit = lookup(vocabulary, d);
            const unknown = hit === null;
            return (
              <span
                key={d}
                data-testid="drug-chip"
                data-recognized={hit ? "true" : unknown ? "false" : "unchecked"}
                title={hit ? hit.drug_class : unknown ? "Not in the drug vocabulary; it will not be matched" : undefined}
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
                  unknown ? "bg-look-soft text-ink ring-1 ring-look" : hit ? "bg-uncounted-soft text-ink" : "bg-white text-ink ring-1 ring-line"
                }`}
              >
                {d}
                {hit ? <span className="text-muted">{hit.drug_class}</span> : null}
                {unknown ? <span className="font-medium text-look">unrecognized</span> : null}
                <button
                  type="button"
                  aria-label={`Remove ${d}`}
                  onClick={() => setDrugs(drugs.filter((x) => x !== d))}
                  className="ml-0.5 text-muted hover:text-ink"
                >
                  ×
                </button>
              </span>
            );
          })}
          <input
            id="idea-drugs"
            data-testid="idea-drugs"
            value={pending}
            onChange={(e) => setPending(e.target.value)}
            onKeyDown={onKey}
            placeholder={drugs.length ? "" : "pembrolizumab, carboplatin"}
            list="drug-vocabulary"
            className="min-w-[8rem] flex-1 bg-transparent py-0.5 text-ink outline-none"
          />
          <datalist id="drug-vocabulary">
            {vocabulary?.drugs.map((d) => (
              <option key={d.name} value={d.name} />
            ))}
          </datalist>
        </div>
        {notice ? (
          <p data-testid="idea-drugs-notice" role="status" className="text-xs text-look">
            {notice}
          </p>
        ) : null}
        {vocabularyFailed ? (
          <p data-testid="idea-vocabulary-error" className="text-xs text-muted">
            Could not load the drug vocabulary, so names are not checked here; the summary lists any the engine did not recognize.
          </p>
        ) : null}
      </div>

      <fieldset className="flex flex-col gap-1 text-sm">
        <legend className="mb-1 font-medium text-ink">Setting</legend>
        <div className="flex flex-wrap gap-1.5">
          {settings.map((tag) => {
            const on = setting.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                data-testid={`idea-setting-${tag}`}
                aria-pressed={on}
                onClick={() => setSetting(on ? setting.filter((s) => s !== tag) : [...setting, tag])}
                className={`rounded-full border px-2.5 py-0.5 text-xs ${
                  on ? "border-ink bg-ink text-paper" : "border-line bg-white text-ink hover:border-muted"
                }`}
              >
                {tag}
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="flex items-center gap-2 text-sm">
        <legend className="sr-only">Phase</legend>
        <span className="font-medium text-ink">Phase</span>
        {phases.map((p) => (
          <label key={p} className="inline-flex items-center gap-1 text-ink">
            <input type="radio" name="phase" value={p} checked={phase === p} onChange={() => setPhase(p)} />
            {p === "PHASE2" ? "2" : "3"}
          </label>
        ))}
      </fieldset>

      <button
        type="submit"
        data-testid="draft-submit"
        disabled={busy || !ready}
        className="rounded-md bg-ink px-3 py-2 text-sm font-medium text-paper disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Drafting…" : "Draft criteria"}
      </button>
    </form>
  );
}
