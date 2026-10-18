import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TrialLens demo",
  description: "Evidence-grounded review of oncology eligibility criteria.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
