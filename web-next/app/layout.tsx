import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ProtocolOS",
  description: "The rationale behind each oncology eligibility criterion, checked against precedent and FDA guidance.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
