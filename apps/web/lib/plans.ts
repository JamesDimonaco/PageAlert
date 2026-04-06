export interface PlanFeature {
  text: string;
  comingSoon?: boolean;
}

export interface Plan {
  name: string;
  price: number;
  period: "forever" | "month";
  popular?: boolean;
  description: string;
  features: PlanFeature[];
}

export const PLANS: Plan[] = [
  {
    name: "Free",
    price: 0,
    period: "forever",
    description: "Get started with basic monitoring",
    features: [
      { text: "3 monitors" },
      { text: "6 hour check interval" },
      { text: "Email notifications" },
      { text: "24 hour data retention" },
      { text: "AI-powered extraction" },
      { text: "Change detection" },
    ],
  },
  {
    name: "Pro",
    price: 9,
    period: "month",
    popular: true,
    description: "For power users who need faster checks",
    features: [
      { text: "25 monitors" },
      { text: "15 minute check interval" },
      { text: "Email, Telegram & Discord" },
      { text: "30 day data retention" },
      { text: "Priority scraping" },
      { text: "AI-powered extraction" },
      { text: "Change detection" },
      { text: "Screenshot diffs", comingSoon: true },
    ],
  },
  {
    name: "Max",
    price: 29,
    period: "month",
    description: "Unlimited monitoring with everything",
    features: [
      { text: "Unlimited monitors" },
      { text: "5 minute check interval" },
      { text: "All notification channels" },
      { text: "90 day data retention" },
      { text: "Priority scraping" },
      { text: "AI-powered extraction" },
      { text: "Change detection" },
      { text: "Webhook notifications", comingSoon: true },
      { text: "API access", comingSoon: true },
      { text: "Screenshot diffs", comingSoon: true },
      { text: "Slack integration", comingSoon: true },
    ],
  },
];

/** Build Schema.org Offer objects from plans */
export function buildOffersJsonLd() {
  return PLANS.map((plan) => ({
    "@type": "Offer" as const,
    name: plan.name,
    price: String(plan.price),
    priceCurrency: "USD",
    description: plan.features.filter((f) => !f.comingSoon).map((f) => f.text).join(", "),
    priceSpecification: {
      "@type": "UnitPriceSpecification" as const,
      price: String(plan.price),
      priceCurrency: "USD",
      unitCode: "MON",
      ...(plan.period !== "forever" && { billingDuration: "P1M" }),
    },
  }));
}
