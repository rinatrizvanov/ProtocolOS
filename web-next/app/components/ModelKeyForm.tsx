"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { EngineError, checkModelKey } from "@/lib/api";
import { PROVIDERS, setModelKey, useModelKey, type ModelKey, type Provider } from "@/lib/visitor";

const focusRing = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";
const field = `min-h-11 rounded-md border border-uncounted bg-paper px-2 py-1.5 text-base text-ink sm:min-h-9 ${focusRing}`;

// What happens to the key, in the words the form shows. It must stay true to trialforge/llm.py and access.py.
export const KEY_PRIVACY =
  "The key stays in this browser tab and is sent only with the requests that need it. The server checks it with the provider's free models lookup, uses it only for the work you start, and never stores or logs it; closing the tab forgets it.";

// The visitor's own OpenAI or Anthropic key. `purpose` says why this screen needs it; `onReady` runs once a key is
// confirmed (also when one was already set), so the caller can retry what needed it.
export function ModelKeyForm({ purpose, onReady, autoFocus = false }: { purpose: string; onReady?: (k: ModelKey) => void; autoFocus?: boolean }) {
  const current = useModelKey();
  const [provider, setProvider] = useState<Provider>("anthropic");
  const [model, setModel] = useState<string>(PROVIDERS.anthropic.models[0]);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    if (autoFocus && !current) input.current?.focus();
  }, [autoFocus, current]);

  function pickProvider(p: Provider) {
    setProvider(p);
    setModel(PROVIDERS[p].models[0]);
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const trimmed = key.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    const candidate: ModelKey = { provider, model, key: trimmed, label: "" };
    try {
      const ok = await checkModelKey(candidate);
      const confirmed = { ...candidate, label: ok.label };
      setModelKey(confirmed);
      setKey("");
      setEditing(false);
      onReady?.(confirmed);
    } catch (err: unknown) {
      setError(err instanceof EngineError ? (err.detail ?? err.message) : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (current && !editing) {
    return (
      <div data-testid="model-key-set" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-white/60 px-3 py-2 text-sm text-ink">
        <span>
          Using your key: <span className="font-medium">{current.label || current.model}</span>
        </span>
        <button type="button" onClick={() => setEditing(true)} className={`min-h-9 rounded px-1 text-ink underline underline-offset-2 ${focusRing}`}>
          Change
        </button>
        <button
          type="button"
          data-testid="model-key-forget"
          onClick={() => setModelKey(null)}
          className={`min-h-9 rounded px-1 text-ink underline underline-offset-2 ${focusRing}`}
        >
          Forget key
        </button>
      </div>
    );
  }

  const p = PROVIDERS[provider];
  return (
    <form data-testid="model-key-form" onSubmit={submit} className="flex max-w-2xl flex-col gap-3 rounded-lg border border-line bg-white/70 p-4" aria-describedby={`${id}-why`}>
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold text-ink">Use your own API key</p>
        <p id={`${id}-why`} className="text-sm text-ink">
          {purpose}
        </p>
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm text-muted">Provider</legend>
        <div className="flex gap-2">
          {(Object.keys(PROVIDERS) as Provider[]).map((k) => (
            <label
              key={k}
              className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm sm:min-h-9 ${
                provider === k ? "border-ink bg-line text-ink" : "border-uncounted text-muted hover:text-ink"
              } has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ink`}
            >
              <input type="radio" name={`${id}-provider`} value={k} checked={provider === k} onChange={() => pickProvider(k)} className="sr-only" />
              {PROVIDERS[k].name}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <label className="flex min-w-0 flex-col gap-1 text-sm text-muted">
          {p.name} API key
          <input
            ref={input}
            data-testid="model-key-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={p.keyHint}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className={`${field} w-full min-w-0 font-mono`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-muted">
          Model
          <select data-testid="model-key-model" value={model} onChange={(e) => setModel(e.target.value)} className={field}>
            {p.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          data-testid="model-key-submit"
          disabled={!key.trim() || busy}
          className={`min-h-11 rounded-md bg-ink px-5 py-2 text-base text-paper transition-opacity duration-150 disabled:opacity-40 ${focusRing}`}
        >
          {busy ? "Checking the key…" : "Use this key"}
        </button>
        {current ? (
          <button type="button" onClick={() => setEditing(false)} className={`min-h-11 rounded px-1 text-sm text-ink underline underline-offset-2 ${focusRing}`}>
            Keep the current key
          </button>
        ) : null}
        <a href={p.keysUrl} target="_blank" rel="noreferrer" className={`text-sm text-ink underline decoration-uncounted underline-offset-2 hover:decoration-ink ${focusRing}`}>
          Get an {p.name} key
        </a>
      </div>
      {error ? (
        <p role="alert" data-testid="model-key-error" className="text-sm text-verdict">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-muted">{KEY_PRIVACY}</p>
    </form>
  );
}
