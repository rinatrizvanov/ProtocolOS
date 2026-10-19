"use client";

// What this browser keeps for the visitor: a random session id (reviewer decisions are stored per session on the public
// demo, trialforge/access.py), the visitor's own model key, and the trials they added. Storage can be blocked; every
// read and write is guarded, and the app still works for the session in memory.

import { useSyncExternalStore } from "react";

export type Provider = "anthropic" | "openai";

// The ids the engine accepts (trialforge/llm.PROVIDERS); the first of each list is the default.
export const PROVIDERS: Record<Provider, { name: string; models: readonly string[]; keyHint: string; keysUrl: string }> = {
  anthropic: {
    name: "Anthropic",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    keyHint: "sk-ant-…",
    keysUrl: "https://console.anthropic.com/settings/keys",
  },
  openai: {
    name: "OpenAI",
    models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"],
    keyHint: "sk-…",
    keysUrl: "https://platform.openai.com/api-keys",
  },
};

export interface ModelKey {
  provider: Provider;
  model: string;
  key: string;
  label: string; // as the engine confirmed it, e.g. "claude-opus-5-5 (Anthropic, your key)"
}

const SESSION_KEY = "protocolos.session.v1";
const MODEL_KEY = "protocolos.modelKey.v1";
const TRIALS_KEY = "protocolos.trials.v1";

function read(store: () => Storage, key: string): string | null {
  try {
    return store().getItem(key);
  } catch {
    return null;
  }
}

function write(store: () => Storage, key: string, value: string | null) {
  try {
    if (value === null) store().removeItem(key);
    else store().setItem(key, value);
  } catch {
    // blocked storage: the value lives in memory for this page only
  }
}

const local = () => window.localStorage;
const tab = () => window.sessionStorage;

let session: string | null = null;

export function sessionId(): string {
  if (session) return session;
  const saved = read(local, SESSION_KEY);
  if (saved && /^[0-9a-f]{32}$/.test(saved)) return (session = saved);
  session = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  write(local, SESSION_KEY, session);
  return session;
}

// The model key is kept in sessionStorage: it is gone when the tab closes, and it is never sent to this site's server
// except with the requests that need it (lib/api.ts, `withKey`).
const listeners = new Set<() => void>();
let memoryKey: ModelKey | null = null;
let cachedRaw: string | null | undefined;
let cachedKey: ModelKey | null = null;

function parseKey(raw: string | null): ModelKey | null {
  if (!raw) return null;
  try {
    const k = JSON.parse(raw) as ModelKey;
    return k && (k.provider === "anthropic" || k.provider === "openai") && typeof k.key === "string" ? k : null;
  } catch {
    return null;
  }
}

export function getModelKey(): ModelKey | null {
  const raw = read(tab, MODEL_KEY);
  if (raw === null) return memoryKey;
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedKey = parseKey(raw);
  }
  return cachedKey;
}

export function setModelKey(k: ModelKey | null) {
  memoryKey = k;
  write(tab, MODEL_KEY, k ? JSON.stringify(k) : null);
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useModelKey(): ModelKey | null {
  return useSyncExternalStore(subscribe, getModelKey, () => null);
}

export function keyHeaders(k: ModelKey | null = getModelKey()): Record<string, string> {
  return k ? { "X-Model-Provider": k.provider, "X-Model-Key": k.key, "X-Model-Name": k.model } : {};
}

// Trials this browser added (analysed with the visitor's key); shown in the trial picker after the preloaded ones.
export function addedTrials(): string[] {
  try {
    const list = JSON.parse(read(local, TRIALS_KEY) ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && /^NCT\d{8}$/.test(x)).slice(0, 20) : [];
  } catch {
    return [];
  }
}

export function rememberTrial(nct: string) {
  const list = [nct, ...addedTrials().filter((x) => x !== nct)].slice(0, 20);
  write(local, TRIALS_KEY, JSON.stringify(list));
}

export function forgetTrial(nct: string) {
  write(local, TRIALS_KEY, JSON.stringify(addedTrials().filter((x) => x !== nct)));
}
