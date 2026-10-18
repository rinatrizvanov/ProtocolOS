import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ProtocolOS",
  description: "The rationale behind each oncology eligibility criterion, checked against precedent and FDA guidance.",
};

// Runs before first paint: hides the onboarding strip when it was dismissed, so the landing never shifts after hydration.
// Storage can be blocked; the strip then simply shows.
const ONBOARDING_SCRIPT = `try{if(localStorage.getItem("protocolos.onboarding.v2")==="dismissed")document.documentElement.dataset.onboarding="dismissed"}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: ONBOARDING_SCRIPT }} />
      </head>
      <body className="antialiased">{children}</body>
    </html>
  );
}
