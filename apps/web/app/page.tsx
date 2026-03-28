"use client";

import { Button } from "@/components/ui/button";
import { Radar, ArrowRight, Zap, Globe, Bell, Shield } from "lucide-react";
import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Nav */}
      <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
              <Radar className="h-5 w-5 text-primary" />
            </div>
            <span className="text-xl font-bold tracking-tight">PageAlert</span>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <Link href="/login">
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground sm:size-default">Sign in</Button>
            </Link>
            <Link href="/login">
              <Button size="sm" className="gap-2 sm:size-default">
                Get Started
                <ArrowRight className="h-4 w-4 hidden sm:inline" />
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

          <div className="mx-auto max-w-7xl px-4 sm:px-6 py-20 sm:py-32 lg:py-40">
            <div className="mx-auto max-w-3xl text-center">
              <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-4 py-1.5 text-sm font-medium text-primary">
                <Zap className="h-3.5 w-3.5" />
                AI-powered web monitoring
              </div>

              <h1 className="text-3xl font-bold tracking-tight leading-[1.1] sm:text-5xl lg:text-7xl lg:tracking-tighter">
                Monitor any website.
                <br />
                <span className="bg-gradient-to-r from-primary via-blue-400 to-primary bg-clip-text text-transparent">
                  Just describe it.
                </span>
              </h1>

              <p className="mx-auto mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground font-normal">
                Paste a URL, tell PageAlert what you&apos;re looking for in plain English,
                and get notified when it appears. No CSS selectors. No code. Just results.
              </p>

              <div className="mt-12 flex flex-col sm:flex-row items-center justify-center gap-4">
                <Link href="/login" className="w-full sm:w-auto">
                  <Button size="lg" className="gap-2 h-12 px-8 text-base font-semibold shadow-lg shadow-primary/20 w-full sm:w-auto">
                    Start Monitoring
                    <ArrowRight className="h-5 w-5" />
                  </Button>
                </Link>
                <Button variant="outline" size="lg" className="h-12 px-8 text-base font-medium w-full sm:w-auto">
                  See how it works
                </Button>
              </div>
            </div>

            {/* Demo preview */}
            <div className="mx-auto mt-24 max-w-4xl">
              <div className="rounded-xl border-t-2 border-t-primary/40 border border-border/30 bg-card/60 p-4 sm:p-8 shadow-xl shadow-black/10 backdrop-blur">
                <div className="flex items-center gap-2 mb-6">
                  <div className="h-3 w-3 rounded-full bg-red-500/50" />
                  <div className="h-3 w-3 rounded-full bg-yellow-500/50" />
                  <div className="h-3 w-3 rounded-full bg-green-500/50" />
                </div>
                <div className="space-y-4">
                  <div className="rounded-lg bg-background/80 p-5 shadow-sm shadow-black/5">
                    <p className="text-xs font-medium text-muted-foreground mb-2">URL</p>
                    <p className="text-sm font-mono text-foreground/90 break-all">https://apple.com/shop/refurbished/mac</p>
                  </div>
                  <div className="rounded-lg bg-background/80 p-5 shadow-sm shadow-black/5">
                    <p className="text-xs font-medium text-muted-foreground mb-2">What are you looking for?</p>
                    <p className="text-sm text-foreground/90">&ldquo;MacBook Pro 14 inch M3 gray under $1500&rdquo;</p>
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <div className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                    <p className="text-xs font-medium text-emerald-400">Monitoring every 15 minutes...</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="border-t border-border/30 bg-card/20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 py-16 sm:py-28">
            <div className="mx-auto max-w-2xl text-center mb-16">
              <h2 className="text-3xl font-bold tracking-tight leading-tight">How it works</h2>
              <p className="mt-4 text-muted-foreground leading-relaxed">
                Three steps to never miss a thing online again
              </p>
            </div>

            <div className="grid gap-8 md:grid-cols-3">
              {[
                {
                  icon: Globe,
                  title: "Paste any URL",
                  description:
                    "Works with any website. Product pages, stock listings, job boards, classified ads - if it's on the web, PageAlert can watch it.",
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
                  className="rounded-xl border-t-2 border-t-primary/30 border border-border/30 bg-card/50 p-8 shadow-md shadow-black/5 backdrop-blur transition-all hover:shadow-lg hover:shadow-black/10 hover:border-primary/20"
                >
                  <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                    <feature.icon className="h-6 w-6 text-primary" />
                  </div>
                  <h3 className="text-lg font-semibold mb-3">{feature.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Pricing preview */}
        <section className="border-t border-border/30">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 py-16 sm:py-28">
            <div className="mx-auto max-w-2xl text-center mb-16">
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight leading-tight">Simple pricing</h2>
              <p className="mt-4 text-muted-foreground leading-relaxed">Start free, upgrade when you need more</p>
            </div>

            <div className="grid gap-8 md:grid-cols-3 max-w-4xl mx-auto">
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
                  <h3 className="text-lg font-semibold">{plan.name}</h3>
                  <p className="mt-3">
                    <span className="text-4xl font-bold tracking-tight">{plan.price}</span>
                    <span className="text-sm text-muted-foreground font-medium">/mo</span>
                  </p>
                  <ul className="mt-8 space-y-3">
                    {plan.features.map((f) => (
                      <li key={f} className="flex items-center gap-2.5 text-sm text-foreground/80">
                        <Shield className="h-4 w-4 text-primary/70 shrink-0" />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <Link href="/login" className="block mt-8">
                    <Button
                      variant={plan.popular ? "default" : "outline"}
                      className={`w-full ${plan.popular ? "shadow-md shadow-primary/20" : ""}`}
                    >
                      Get started
                    </Button>
                  </Link>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section className="border-t border-border/30">
          <div className="mx-auto max-w-3xl px-4 sm:px-6 py-16 sm:py-28">
            <div className="text-center mb-12 sm:mb-16">
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight leading-tight">Frequently asked questions</h2>
            </div>
            <div className="space-y-6">
              {[
                {
                  q: "How does PageAlert work?",
                  a: "Paste a URL, describe what you're looking for in plain English (like 'MacBook Pro under $1500'), and PageAlert uses AI to understand the page, extract products and data, and monitor it automatically. You get notified via email when your conditions are met.",
                },
                {
                  q: "What kind of websites can I monitor?",
                  a: "Any website — product pages, stock listings, job boards, classified ads, real estate, auction sites, and more. If it's on the web and has data you care about, PageAlert can watch it.",
                },
                {
                  q: "Do I need to know CSS selectors or coding?",
                  a: "No. Unlike traditional web monitoring tools, PageAlert uses AI to understand pages. Just describe what you want in plain English — no CSS selectors, XPath, or code required.",
                },
                {
                  q: "How often does PageAlert check my pages?",
                  a: "Check frequency depends on your plan. Free accounts check every 6 hours, Pro every 15 minutes, and Business every 5 minutes. You choose the frequency per monitor.",
                },
                {
                  q: "How will I be notified when something changes?",
                  a: "Email notifications are included on all plans. Pro and Business plans also support Telegram and Discord notifications. You'll receive detailed alerts with what matched, prices, and direct links.",
                },
                {
                  q: "Is there a free plan?",
                  a: "Yes! The free plan includes 3 monitors with 6-hour check intervals and email notifications. No credit card required to get started.",
                },
              ].map((faq) => (
                <details key={faq.q} className="group rounded-xl border border-border/30 bg-card/50 shadow-sm">
                  <summary className="flex cursor-pointer items-center justify-between p-4 sm:p-6 text-sm sm:text-base font-semibold [&::-webkit-details-marker]:hidden">
                    {faq.q}
                    <span className="ml-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-45">+</span>
                  </summary>
                  <div className="px-4 sm:px-6 pb-4 sm:pb-6 text-sm text-muted-foreground leading-relaxed">
                    {faq.a}
                  </div>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
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
              <a href="https://github.com/JamesDimonaco/prowl" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">GitHub</a>
              <a href="https://james.dimonaco.co.uk" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">Made by James DiMonaco</a>
            </nav>
          </div>
          <div className="mt-6 pt-6 border-t border-border/20">
            <p className="text-xs text-muted-foreground/60">&copy; {new Date().getFullYear()} PageAlert. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
