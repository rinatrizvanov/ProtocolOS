import type { ReactNode } from "react";

// Every screen: one headline (<= 12 words), one focal visual, one caption (<= 25 words), the rest behind Details.
export function Frame({
  headline,
  caption,
  details,
  children,
}: {
  headline: string;
  caption: ReactNode;
  details?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h1 data-role="headline" className="text-balance text-2xl font-semibold tracking-tight text-ink">
          {headline}
        </h1>
        <p data-role="caption" className="max-w-3xl text-base text-muted">
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

export function Failed({ message }: { message: string }) {
  return (
    <p role="alert" className="text-base text-verdict">
      Could not load: {message}
    </p>
  );
}
