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
    <section className="flex min-h-0 flex-1 flex-col gap-6">
      <h1 data-role="headline" className="text-balance text-4xl font-semibold tracking-tight text-ink">
        {headline}
      </h1>
      <div className="flex min-h-[380px] flex-1 items-center justify-center">{children}</div>
      <p data-role="caption" className="max-w-3xl text-lg text-muted">
        {caption}
      </p>
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
  return <p className="text-lg text-muted">{label}</p>;
}

export function Failed({ message }: { message: string }) {
  return (
    <p role="alert" className="text-lg text-verdict">
      Could not load: {message}
    </p>
  );
}
