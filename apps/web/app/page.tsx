"use client";

import { Button } from "@/components/ui/button";
import { Radar, ArrowRight, Zap, Globe, Bell, Shield } from "lucide-react";
import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Nav */}
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
              <Radar className="h-5 w-5 text-primary" />
            </div>
            <span className="text-xl font-bold tracking-tight">Prowl</span>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/login">
              <Button variant="ghost">Sign in</Button>
            </Link>
            <Link href="/login">
              <Button className="gap-2">
                Get Started
                <ArrowRight className="h-4 w-4" />
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <main className="flex-1">
        <section className="relative overflow-hidden">
          {/* Gradient background */}
          <div className="absolute inset-0 -z-10">
            <div className="absolute left-1/2 top-0 -translate-x-1/2 h-[600px] w-[800px] rounded-full bg-primary/5 blur-3xl" />
            <div className="absolute left-1/4 top-32 h-[400px] w-[400px] rounded-full bg-primary/3 blur-3xl" />
          </div>

          <div className="mx-auto max-w-7xl px-6 py-24 lg:py-32">
            <div className="mx-auto max-w-3xl text-center">
              <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-sm text-primary">
                <Zap className="h-3.5 w-3.5" />
                AI-powered web monitoring
              </div>

              <h1 className="text-5xl font-bold tracking-tight lg:text-7xl">
                Monitor any website.
                <br />
                <span className="bg-gradient-to-r from-primary via-blue-400 to-primary bg-clip-text text-transparent">
                  Just describe it.
                </span>
              </h1>

              <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground">
                Paste a URL, tell Prowl what you&apos;re looking for in plain English,
                and get notified when it appears. No CSS selectors. No code. Just results.
              </p>

              <div className="mt-10 flex items-center justify-center gap-4">
                <Link href="/login">
                  <Button size="lg" className="gap-2 h-12 px-8 text-base">
                    Start Monitoring
                    <ArrowRight className="h-5 w-5" />
                  </Button>
                </Link>
                <Button variant="outline" size="lg" className="h-12 px-8 text-base">
                  See how it works
                </Button>
              </div>
            </div>

            {/* Demo preview */}
            <div className="mx-auto mt-20 max-w-4xl">
              <div className="rounded-xl border border-border/50 bg-card/50 p-6 backdrop-blur">
                <div className="flex items-center gap-2 mb-4">
                  <div className="h-3 w-3 rounded-full bg-red-500/50" />
                  <div className="h-3 w-3 rounded-full bg-yellow-500/50" />
                  <div className="h-3 w-3 rounded-full bg-green-500/50" />
                </div>
                <div className="space-y-4">
                  <div className="rounded-lg bg-background/80 p-4 border border-border/30">
                    <p className="text-xs text-muted-foreground mb-2">URL</p>
                    <p className="text-sm font-mono">https://apple.com/shop/refurbished/mac</p>
                  </div>
                  <div className="rounded-lg bg-background/80 p-4 border border-border/30">
                    <p className="text-xs text-muted-foreground mb-2">What are you looking for?</p>
                    <p className="text-sm">&ldquo;MacBook Pro 14 inch M3 gray under $1500&rdquo;</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                    <p className="text-xs text-emerald-400">Monitoring every 15 minutes...</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="border-t border-border/50 bg-card/30">
          <div className="mx-auto max-w-7xl px-6 py-24">
            <div className="mx-auto max-w-2xl text-center mb-16">
              <h2 className="text-3xl font-bold tracking-tight">How it works</h2>
              <p className="mt-3 text-muted-foreground">
                Three steps to never miss a thing online again
              </p>
            </div>

            <div className="grid gap-8 md:grid-cols-3">
              {[
                {
                  icon: Globe,
                  title: "Paste any URL",
                  description:
                    "Works with any website. Product pages, stock listings, job boards, classified ads - if it's on the web, Prowl can watch it.",
                },
                {
                  icon: Zap,
                  title: "Describe in English",
                  description:
                    "No CSS selectors or XPath. Just describe what you're looking for like you'd tell a friend. AI handles the extraction.",
                },
                {
                  icon: Bell,
                  title: "Get notified instantly",
                  description:
                    "Telegram, Discord, or email. Choose your channel and get alerted the moment your conditions are met.",
                },
              ].map((feature) => (
                <div
                  key={feature.title}
                  className="rounded-xl border border-border/50 bg-card/50 p-6 backdrop-blur transition-colors hover:border-primary/20"
                >
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                    <feature.icon className="h-6 w-6 text-primary" />
                  </div>
                  <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing preview */}
        <section className="border-t border-border/50">
          <div className="mx-auto max-w-7xl px-6 py-24">
            <div className="mx-auto max-w-2xl text-center mb-16">
              <h2 className="text-3xl font-bold tracking-tight">Simple pricing</h2>
              <p className="mt-3 text-muted-foreground">Start free, upgrade when you need more</p>
            </div>

            <div className="grid gap-6 md:grid-cols-3 max-w-4xl mx-auto">
              {[
                {
                  name: "Free",
                  price: "$0",
                  features: ["3 monitors", "6 hour checks", "Email notifications"],
                },
                {
                  name: "Pro",
                  price: "$9",
                  popular: true,
                  features: [
                    "25 monitors",
                    "15 minute checks",
                    "All notification channels",
                    "Priority scraping",
                  ],
                },
                {
                  name: "Business",
                  price: "$29",
                  features: [
                    "Unlimited monitors",
                    "5 minute checks",
                    "All channels + webhooks",
                    "API access",
                  ],
                },
              ].map((plan) => (
                <div
                  key={plan.name}
                  className={`rounded-xl border p-6 ${
                    plan.popular
                      ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
                      : "border-border/50 bg-card/50"
                  }`}
                >
                  {plan.popular && (
                    <span className="mb-4 inline-block rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                      Most popular
                    </span>
                  )}
                  <h3 className="text-lg font-semibold">{plan.name}</h3>
                  <p className="mt-2">
                    <span className="text-4xl font-bold">{plan.price}</span>
                    <span className="text-muted-foreground">/mo</span>
                  </p>
                  <ul className="mt-6 space-y-2.5">
                    {plan.features.map((f) => (
                      <li key={f} className="flex items-center gap-2 text-sm">
                        <Shield className="h-4 w-4 text-primary" />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <Link href="/login" className="block mt-6">
                    <Button
                      variant={plan.popular ? "default" : "outline"}
                      className="w-full"
                    >
                      Get started
                    </Button>
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/50 bg-card/30">
        <div className="mx-auto max-w-7xl px-6 py-8">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Radar className="h-4 w-4" />
              Prowl
            </div>
            <p className="text-xs text-muted-foreground">
              Built with Next.js, Convex, and Claude
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
