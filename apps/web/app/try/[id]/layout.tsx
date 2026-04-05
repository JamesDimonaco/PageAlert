import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Scan Results",
  description: "See what PageAlert found on this website. AI-powered web monitoring — no signup required.",
  robots: { index: false, follow: true },
};

export default function TryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
