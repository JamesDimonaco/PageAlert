import { Zap, Globe, Bell, Shield, Github, Radar } from "lucide-react";
import Link from "next/link";
import { PLANS } from "@/lib/plans";
import { LandingNav } from "@/components/prowl/landing-nav";
import { HeroCTA } from "@/components/prowl/hero-cta";
import { MonitorCountBadge } from "@/components/prowl/monitor-count-badge";
import { TryScanner } from "@/components/prowl/try-scanner";
import { ExampleResults } from "@/components/prowl/example-results";
import { Testimonials } from "@/components/prowl/testimonials";

export default function LandingPage() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* Nav (client — auth-aware) */}
      <LandingNav />

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
                AI-powered website monitoring
              </div>

              <h1 className="text-3xl font-bold tracking-tight leading-[1.1] sm:text-5xl lg:text-7xl lg:tracking-tighter">
                Monitor any website for
                <br />
                <span className="bg-gradient-to-r from-primary via-blue-400 to-primary bg-clip-text text-transparent">
                  price drops &amp; restocks.
                </span>
              </h1>

              <p className="mx-auto mt-8 max-w-xl text-lg leading-relaxed text-muted-foreground font-normal">
                Describe what you&apos;re looking for in plain English and get notified
                when it appears. Track prices, stock availability, new listings, and
                more &mdash; no code or CSS selectors needed.
              </p>

              {/* CTA (client — auth-aware) */}
              <HeroCTA />

              {/* Trust signals */}
              <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Shield className="h-3.5 w-3.5" />
                  No credit card required
                </span>
                <span className="flex items-center gap-1.5">
                  <Github className="h-3.5 w-3.5" />
                  Open source
                </span>
                {/* Monitor count (client — Convex query) */}
                <MonitorCountBadge />
              </div>

              {/* Use case examples */}
              <div className="mt-10 flex flex-wrap items-center justify-center gap-2">
                {[
                  "MacBook Pro under $1500",
                  "PS5 back in stock",
                  "3 bed house under 400k",
                  "Remote React jobs",
                ].map((example) => (
                  <span key={example} className="rounded-full border border-border/30 bg-card/50 px-3 py-1 text-xs text-muted-foreground">
                    &ldquo;{example}&rdquo;
                  </span>
                ))}
              </div>
            </div>

            {/* Example results showcase (inline) */}
            <ExampleResults />

            {/* Interactive try-it scanner (client) */}
            <TryScanner />
          </div>
        </section>

        {/* Features */}
        <section id="how-it-works" className="border-t border-border/30 bg-card/20 scroll-mt-20">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 py-16 sm:py-28">
            <div className="mx-auto max-w-2xl text-center mb-16">
              <h2 className="text-3xl font-bold tracking-tight leading-tight">How it works</h2>
              <p className="mt-4 text-muted-foreground leading-relaxed">
                No CSS selectors. No code. No setup that breaks when pages change.
              </p>
            </div>

            <div className="grid gap-8 md:grid-cols-3">
              {[
                {
                  icon: Globe,
                  title: "Paste any URL",
                  description:
                    "Works with any website. Product pages, stock listings, job boards, classified ads — if it's on the web, PageAlert can watch it.",
                },
                {
                  icon: Zap,
                  title: "Describe in plain English",
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

        <Testimonials />

        {/* Pricing preview */}
        <section className="border-t border-border/30">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 py-16 sm:py-28">
            <div className="mx-auto max-w-2xl text-center mb-16">
              <h2 className="text-2xl sm:text-3xl font-bold tracking-tight leading-tight">Simple pricing</h2>
              <p className="mt-4 text-muted-foreground leading-relaxed">Start free, upgrade when you need more</p>
            </div>

            <div className="grid gap-8 md:grid-cols-3 max-w-4xl mx-auto">
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
                  <h3 className="text-lg font-semibold">{plan.name}</h3>
                  <p className="mt-3">
                    <span className="text-4xl font-bold tracking-tight">${plan.price}</span>
                    <span className="text-sm text-muted-foreground font-medium">/mo</span>
                  </p>
                  <ul className="mt-8 space-y-3">
                    {plan.features.filter((f) => !f.comingSoon).slice(0, 4).map((f) => (
                      <li key={f.text} className="flex items-center gap-2.5 text-sm text-foreground/80">
                        <Shield className="h-4 w-4 text-primary/70 shrink-0" />
                        {f.text}
                      </li>
                    ))}
                  </ul>
                  <Link
                    href="/login"
                    className={`mt-8 flex w-full items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                      plan.popular
                        ? "bg-primary text-primary-foreground shadow-md shadow-primary/20 hover:bg-primary/90"
                        : "border border-input bg-background hover:bg-accent hover:text-accent-foreground"
                    }`}
                  >
                    Get started
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
                  a: "No. Traditional monitoring tools like Visualping or Distill require you to select page elements that break when sites update their layout. PageAlert uses AI to re-read the page every time — no selectors to maintain, nothing breaks when a site redesigns.",
                },
                {
                  q: "How often does PageAlert check my pages?",
                  a: "Check frequency depends on your plan. Free accounts check every 6 hours, Pro every 15 minutes, and Max every 5 minutes. You choose the frequency per monitor.",
                },
                {
                  q: "How will I be notified when something changes?",
                  a: "Email notifications are included on all plans. Pro and Max plans also support Telegram and Discord notifications. You'll receive detailed alerts with what matched, prices, and direct links.",
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
              <Link href="/pricing" className="hover:text-foreground transition-colors">Pricing</Link>
              <Link href="/privacy" className="hover:text-foreground transition-colors">Privacy Policy</Link>
              <Link href="/terms" className="hover:text-foreground transition-colors">Terms of Service</Link>
              <a href="https://github.com/JamesDimonaco/prowl" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">GitHub</a>
              <a href="https://james.dimonaco.co.uk" target="_blank" rel="noopener noreferrer" className="hover:text-foreground transition-colors">Made by James DiMonaco</a>
            </nav>
          </div>
          <div className="mt-6 pt-6 border-t border-border/20 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground/60">&copy; {new Date().getFullYear()} PageAlert. All rights reserved.</p>
            <a href="https://www.producthunt.com/products/pagealert?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-pagealert" target="_blank" rel="noopener noreferrer">
              <img alt="PageAlert on Product Hunt" width="250" height="54" loading="lazy" decoding="async" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1110261&theme=dark&t=1775009427331" />
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
