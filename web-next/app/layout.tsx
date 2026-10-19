import type { Metadata } from "next";
import "./globals.css";

const DESCRIPTION = "The rationale behind each oncology eligibility criterion, checked against precedent and FDA guidance.";

// Link previews (LinkedIn, Slack, X): app/opengraph-image.png and twitter-image.png are picked up by file convention;
// metadataBase makes their URLs absolute. PROTOCOLOS_SITE_URL overrides the public address for another deployment.
export const metadata: Metadata = {
  metadataBase: new URL(process.env.PROTOCOLOS_SITE_URL ?? "https://protocolos-web.vercel.app"),
  title: "ProtocolOS",
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: "ProtocolOS",
    title: "ProtocolOS: every exclusion deserves a rationale",
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "ProtocolOS: every exclusion deserves a rationale",
    description: DESCRIPTION,
  },
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
