import type { ReactNode } from "react";

// Every screen: one headline, one focal visual, one caption, the rest behind Details.
// `variant="tour"` (default) is the guided tour: an h1 slogan at display size. `variant="app"` is a tab inside /review,
// where the page already names the trial (h1) and the criterion (h2): the tab heading is an h3 at body scale.
export function Frame({
  headline,
  caption,
  details,
  children,
  variant = "tour",
}: {
  headline: string;
  caption: ReactNode;
  details?: ReactNode;
  children: ReactNode;
  variant?: "tour" | "app";
}) {
  const app = variant === "app";
  const Heading = app ? "h3" : "h1";
  return (
    <section className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Heading
          data-role="headline"
          className={app ? "text-base font-semibold text-ink" : "text-balance text-2xl font-semibold tracking-tight text-ink"}
        >
          {headline}
        </Heading>
        <p data-role="caption" className={`max-w-3xl text-muted ${app ? "text-sm" : "text-base"}`}>
          {caption}
        </p>
      </div>
      <div className="flex w-full flex-col">{children}</div>
      {details ? (
        <details className="max-w-3xl text-sm text-muted">
          <summary className="cursor-pointer select-none py-1 text-ink">Details</summary>
          <div className="mt-2 space-y-2">{details}</div>
        </details>
      ) : null}
    </section>
  );
}

export function Pending({ label }: { label: string }) {
  return <p className="text-base text-muted">{label}</p>;
}

// `action` names what failed in plain words ("save the decision"); the technical line stays small and secondary.
// `engine` adds the likely cause when a request to the engine failed; it is off for a gap in the data itself.
export function Failed({
  message,
  action = "load this part of the review",
  engine = true,
}: {
  message: string;
  action?: string;
  engine?: boolean;
}) {
  return (
    <div role="alert" className="flex flex-col gap-0.5">
      <p className="text-base text-verdict">Could not {action}.</p>
      <p className="text-xs text-muted">
        {engine ? "The ProtocolOS engine may be starting or unreachable; try again in a few seconds. " : null}
        <span className="break-words">Detail: {message}</span>
      </p>
    </div>
  );
}
