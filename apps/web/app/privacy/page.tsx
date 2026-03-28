import type { Metadata } from "next";
import Link from "next/link";
import { Radar } from "lucide-react";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How PageAlert collects, uses, and protects your data.",
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/30 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-4xl items-center px-6">
          <Link href="/" className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
              <Radar className="h-5 w-5 text-primary" />
            </div>
            <span className="text-xl font-bold tracking-tight">PageAlert</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-16">
        <h1 className="text-3xl font-bold tracking-tight mb-2">Privacy Policy</h1>
        <p className="text-sm text-muted-foreground mb-12">Last updated: March 2026</p>

        <div className="prose prose-invert prose-sm max-w-none space-y-8 text-muted-foreground [&_h2]:text-foreground [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-10 [&_h2]:mb-4 [&_strong]:text-foreground">
          <h2>What we collect</h2>
          <p>When you create an account, we collect your <strong>email address</strong> and <strong>name</strong> (if provided via Google/GitHub sign-in). We use this to authenticate you and send notifications.</p>
          <p>When you create monitors, we store the <strong>URLs you provide</strong> and your <strong>search prompts</strong>. We scrape these URLs on your behalf to check for matches.</p>
          <p>We collect <strong>anonymous usage analytics</strong> via PostHog to understand how the product is used. This includes page views, feature usage, and error tracking. We do not sell this data.</p>

          <h2>How we use your data</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>To provide the monitoring service (scraping URLs, detecting matches)</li>
            <li>To send you email notifications when matches are found</li>
            <li>To process payments via our billing provider (Polar)</li>
            <li>To improve the product based on usage analytics</li>
            <li>To communicate with you about your account or service updates</li>
          </ul>

          <h2>Third-party services</h2>
          <p>We use the following third-party services that may process your data:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li><strong>Convex</strong> — database and backend (stores your monitors, results, account data)</li>
            <li><strong>Anthropic (Claude)</strong> — AI service for understanding web pages (page content is sent for extraction)</li>
            <li><strong>Resend</strong> — email delivery for notifications</li>
            <li><strong>Polar</strong> — payment processing for subscriptions</li>
            <li><strong>PostHog</strong> — anonymous product analytics and error tracking</li>
            <li><strong>Vercel</strong> — web hosting</li>
            <li><strong>Railway</strong> — scraper hosting</li>
          </ul>

          <h2>Cookies</h2>
          <p>We use essential cookies for authentication (keeping you signed in). We also use PostHog analytics cookies to understand product usage. You can opt out of analytics by using a browser ad blocker or disabling cookies.</p>

          <h2>Data retention</h2>
          <p>Your monitor data and scrape results are retained as long as your account is active. If you delete your account, all associated data (monitors, results, notifications) is permanently removed.</p>

          <h2>Your rights</h2>
          <p>You can:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li><strong>Access</strong> your data — view all your monitors and results in the dashboard</li>
            <li><strong>Delete</strong> your data — delete individual monitors or your entire account from Settings</li>
            <li><strong>Export</strong> your data — contact us and we will provide your data</li>
            <li><strong>Opt out</strong> of analytics — use a browser ad blocker or disable cookies</li>
          </ul>

          <h2>Security</h2>
          <p>We use HTTPS for all communications, secure authentication via Better Auth with OAuth providers, and encrypt sensitive data at rest via our infrastructure providers.</p>

          <h2>Contact</h2>
          <p>For any questions about your data or this policy, email <a href="mailto:dimonaco.james@gmail.com" className="text-primary hover:underline">dimonaco.james@gmail.com</a>.</p>
        </div>

        <div className="mt-12 pt-8 border-t border-border/20">
          <Link href="/" className="text-sm text-primary hover:underline">&larr; Back to PageAlert</Link>
        </div>
      </main>
    </div>
  );
}
