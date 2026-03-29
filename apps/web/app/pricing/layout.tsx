import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Simple, transparent pricing for AI-powered website monitoring. Start free with 3 monitors. Upgrade to Pro or Max for faster checks and more monitors.",
  alternates: { canonical: "https://pagealert.io/pricing" },
};

export default function PricingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
