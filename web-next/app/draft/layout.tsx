import type { Metadata } from "next";

// page.tsx is a client component, so the mode's document title lives here.
export const metadata: Metadata = {
  title: "Create criteria from an idea · ProtocolOS",
};

export default function DraftLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
