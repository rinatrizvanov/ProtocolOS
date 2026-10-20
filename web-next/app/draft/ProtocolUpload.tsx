"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Draft } from "@/lib/contracts";
import { keyHeaders, sessionId } from "@/lib/visitor";
import { ModelKeyForm } from "../components/ModelKeyForm";
import BeforeAfter, { type ReviewLite } from "./BeforeAfter";

// trialforge/upload.py: the review of an uploaded protocol against this draft's precedents.
interface UploadResult extends ReviewLite {
  upload_id: string;
  draft_id: string;
  file_name: string;
  pages: number;
  precedents: string[];
  computed_at: string;
}

type State =
  | { status: "idle" }
  | { status: "busy"; name: string }
  | { status: "key"; message: string; file: File }
  | { status: "error"; message: string }
  | { status: "ready"; result: UploadResult };

const KEY_CODES = new Set(["key_required", "key_invalid", "key_malformed", "model_unavailable"]);
const MAX_MB = 25;
// The last upload per draft, so a reload in this tab shows it again (the server keeps it for this session).
const storageKey = (draftId: string) => `protocolos.upload.${draftId}`;

async function send(draftId: string, file: File): Promise<UploadResult> {
  const res = await fetch(`/api/draft/${encodeURIComponent(draftId)}/protocol`, {
    method: "POST",
    body: file,
    headers: { "content-type": "application/pdf", "X-File-Name": file.name, "X-ProtocolOS-Session": sessionId(), ...keyHeaders() },
  });
  const body = (await res.json().catch(() => ({}))) as { detail?: unknown; code?: unknown };
  if (!res.ok) throw Object.assign(new Error(typeof body.detail === "string" ? body.detail : `upload failed (${res.status})`), { code: body.code });
  return body as UploadResult;
}

export default function ProtocolUpload({ draft, onOpen }: { draft: Draft; onOpen?: (id: string) => void }) {
  const [state, setState] = useState<State>({ status: "idle" });
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = window.sessionStorage.getItem(storageKey(draft.draft_id));
    } catch {
      return; // storage blocked: nothing to restore
    }
    if (!saved || !/^u-[0-9a-f]{12}$/.test(saved)) return;
    let live = true;
    fetch(`/api/draft/${encodeURIComponent(draft.draft_id)}/protocol/${saved}`, { headers: { "X-ProtocolOS-Session": sessionId() } })
      .then((r) => (r.ok ? (r.json() as Promise<UploadResult>) : null))
      .then((result) => {
        if (live && result) setState({ status: "ready", result });
      })
      .catch((err: unknown) => console.error(err));
    return () => {
      live = false;
    };
  }, [draft.draft_id]);

  function run(file: File) {
    if (file.size > MAX_MB * 1024 * 1024) {
      setState({ status: "error", message: `The PDF is larger than ${MAX_MB} MB.` });
      return;
    }
    setState({ status: "busy", name: file.name });
    send(draft.draft_id, file).then(
      (result) => {
        try {
          window.sessionStorage.setItem(storageKey(draft.draft_id), result.upload_id);
        } catch {
          // storage blocked: the result shows now and is not restored after a reload
        }
        setState({ status: "ready", result });
      },
      (err: Error & { code?: unknown }) => {
        if (typeof err.code === "string" && KEY_CODES.has(err.code)) setState({ status: "key", message: err.message, file });
        else setState({ status: "error", message: err.message });
      },
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const file = input.current?.files?.[0];
    if (file) run(file);
  }

  return (
    <section data-testid="protocol-upload" aria-labelledby="protocol-upload-title" className="flex flex-col gap-3 rounded-lg border border-line bg-white p-4">
      <div className="flex flex-col gap-1">
        <h2 id="protocol-upload-title" className="text-lg font-semibold text-ink">
          Compare with your protocol
        </h2>
        <p className="text-sm text-muted">
          Upload a protocol PDF: its lab, ECOG and washout criteria are read with the same extractor and each is reviewed against this
          draft&apos;s precedents. Upload only a protocol that is already public. The server reads its text, deletes the file, and keeps the
          extracted criteria for this browser only.
        </p>
      </div>
      <form onSubmit={submit} className="flex flex-wrap items-center gap-3">
        <input
          ref={input}
          data-testid="protocol-file"
          type="file"
          accept="application/pdf,.pdf"
          aria-label="Protocol PDF"
          className="max-w-full text-sm text-ink file:mr-3 file:min-h-9 file:rounded-md file:border file:border-ink file:bg-paper file:px-3 file:text-sm file:text-ink"
        />
        <button
          type="submit"
          data-testid="protocol-submit"
          disabled={state.status === "busy"}
          className="min-h-11 rounded-md bg-ink px-4 py-2 text-sm text-paper disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink sm:min-h-9"
        >
          {state.status === "busy" ? "Reading the protocol…" : "Review my protocol"}
        </button>
      </form>
      {state.status === "busy" ? (
        <p role="status" className="text-sm text-muted">
          Reading {state.name} and reviewing each criterion; a long protocol can take a minute.
        </p>
      ) : null}
      {state.status === "error" ? (
        <p role="alert" data-testid="protocol-error" className="text-sm text-verdict">
          {state.message}
        </p>
      ) : null}
      {state.status === "key" ? (
        <ModelKeyForm
          autoFocus
          purpose="Reviewing an uploaded protocol runs on the demo server, so it needs your own OpenAI or Anthropic key; the review itself uses no model tokens."
          onReady={() => run(state.file)}
        />
      ) : null}
      {state.status === "ready" ? (
        <BeforeAfter
          draft={draft}
          written={{
            review: state.result,
            title: state.result.file_name,
            note: `${state.result.pages} pages read on ${state.result.computed_at}; each value reviewed against ${state.result.precedents.length} precedents.`,
          }}
          onOpen={onOpen}
        />
      ) : null}
    </section>
  );
}
