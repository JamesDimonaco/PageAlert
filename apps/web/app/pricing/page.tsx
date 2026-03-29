"use client";

import { buttonVariants } from "@/components/ui/button";
import { Radar, Check, ArrowRight } from "lucide-react";
import Link from "next/link";
import { PLANS, buildOffersJsonLd } from "@/lib/plans";

const pricingJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  name: "PageAlert Pricing",
  description: "Pricing plans for PageAlert AI-powered website monitoring",
  mainEntity: {
    "@type": "SoftwareApplication",
    "@id": "https://pagealert.io/#app",
    name: "PageAlert",
    offers: buildOffersJsonLd(),
  },
};

export default function PricingPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
              <Radar className="h-5 w-5 text-primary" />
            </div>
            <span className="text-xl font-bold tracking-tight">PageAlert</span>
          </Link>
          <div className="flex items-center gap-2 sm:gap-3">
            <Link href="/login" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Sign in
            </Link>
            <Link href="/login" className={buttonVariants({ size: "sm", className: "gap-2" })}>
              Get Started
              <ArrowRight className="h-4 w-4 hidden sm:inline" />
            </Link>
          </div>
        </div>
      </header>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(pricingJsonLd) }}
      />

      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-16 sm:py-28">
        <div className="mx-auto max-w-2xl text-center mb-16">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight leading-tight">
            Simple, transparent pricing
          </h1>
          <p className="mt-4 text-lg text-muted-foreground leading-relaxed">
            Start free. Upgrade when you need faster checks and more monitors.
            <br />
            No credit card required.
          </p>
        </div>

        <div className="grid gap-8 md:grid-cols-3 max-w-5xl mx-auto">
          {PLANS.map((plan) => (
            <div
              key={plan.name}
              className={`rounded-xl p-8 transition-all ${
                plan.popular
                  ? "border-t-2 border-t-primary border border-primary/30 bg-primary/5 shadow-lg shadow-primary/10 ring-1 ring-primary/20 scale-[1.02]"
                  : "border border-border/30 bg-card/50 shadow-md shadow-black/5"
              }`}
            >
              {plan.popular && (
                <span className="mb-5 inline-block rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
                  Most popular
                </span>
              )}
              <h2 className="text-lg font-semibold">{plan.name}</h2>
              <p className="text-sm text-muted-foreground mt-1">{plan.description}</p>
              <p className="mt-4">
                <span className="text-4xl font-bold tracking-tight">${plan.price}</span>
                <span className="text-sm text-muted-foreground font-medium">
                  /{plan.period === "forever" ? "forever" : "mo"}
                </span>
              </p>
              <ul className="mt-8 space-y-3">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-center gap-2.5 text-sm text-foreground/80">
                    <Check className="h-4 w-4 text-primary/70 shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link
                href="/login"
                className={buttonVariants({
                  variant: plan.popular ? "default" : "outline",
                  className: `w-full mt-8 ${plan.popular ? "shadow-md shadow-primary/20" : ""}`,
                })}
              >
                {plan.period === "forever" ? "Start for free" : `Get ${plan.name}`}
              </Link>
            </div>
          ))}
        </div>

        <div className="mt-16 text-center">
          <p className="text-sm text-muted-foreground">
            All plans include AI-powered extraction, change detection, and email alerts.
            <br />
            Need something custom?{" "}
            <a href="mailto:dimonaco.james@gmail.com" className="text-primary hover:underline">
              Get in touch
            </a>
          </p>
        </div>
      </main>

      <footer className="border-t border-border/30 bg-card/20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-12">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground font-medium">
              <Radar className="h-4 w-4" />
              PageAlert
            </div>
            <nav className="flex flex-wrap items-center gap-6 text-xs text-muted-foreground">
              <Link href="/privacy" className="hover:text-foreground transition-colors">Privacy Policy</Link>
              <Link href="/terms" className="hover:text-foreground transition-colors">Terms of Service</Link>
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
