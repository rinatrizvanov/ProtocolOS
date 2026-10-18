"use client";

import { useSyncExternalStore } from "react";
import { CloseIcon } from "./Icons";

const KEY = "protocolos.onboarding.v2";
const STEPS = [
  { n: 1, title: "Pick a trial or an idea", text: "Review a posted protocol, or draft criteria for a new concept." },
  {
    n: 2,
    title: "Read the rationale",
    text: "Each criterion shows its likely rationale, which arm it comes from where a drug link exists, and what similar trials used.",
  },
  { n: 3, title: "Verify, then decide", text: "Propose another limit, see the deterministic verifier's verdict, then record the team's reason." },
];

const listeners = new Set<() => void>();
function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "dismissed";
  } catch {
    return false;
  }
}
let dismissedThisLoad = false;
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// First-run strip: three steps, dismissible; storage may be blocked, so every access is guarded. The server renders it
// (so its height is in the first paint); the inline script in layout.tsx hides it before paint once it was dismissed.
export function Onboarding() {
  const dismissed = useSyncExternalStore(subscribe, () => dismissedThisLoad || readDismissed(), () => false);
  if (dismissed) return null;
  const dismiss = () => {
    dismissedThisLoad = true;
    try {
      window.localStorage.setItem(KEY, "dismissed");
    } catch {
      /* storage unavailable: hide for this page load only */
    }
    document.documentElement.dataset.onboarding = "dismissed";
    listeners.forEach((l) => l());
  };
  return (
    <section data-testid="onboarding" aria-label="How ProtocolOS works" className="rounded-lg border border-line bg-white/60 p-4">
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-sm font-semibold text-muted">How it works</h2>
        <button
          type="button"
          data-testid="onboarding-dismiss"
          onClick={dismiss}
          aria-label="Dismiss the introduction"
          className="-m-2 grid h-11 w-11 place-items-center rounded text-muted hover:bg-line hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
        >
          <CloseIcon />
        </button>
      </div>
      <ol className="mt-2 grid gap-3 sm:grid-cols-3">
        {STEPS.map((s) => (
          <li key={s.n} className="flex gap-3">
            <span aria-hidden className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink text-xs font-semibold tabular-nums text-paper">
              {s.n}
            </span>
            <span>
              <span className="block text-sm font-medium text-ink">{s.title}</span>
              <span className="block text-sm text-muted">{s.text}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
