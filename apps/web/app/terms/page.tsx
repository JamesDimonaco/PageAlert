import type { Metadata } from "next";
import Link from "next/link";
import { Radar } from "lucide-react";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "Terms and conditions for using PageAlert.",
};

export default function TermsPage() {
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
        <h1 className="text-3xl font-bold tracking-tight mb-2">Terms of Service</h1>
        <p className="text-sm text-muted-foreground mb-12">Last updated: March 2026</p>

        <div className="prose prose-invert prose-sm max-w-none space-y-8 text-muted-foreground [&_h2]:text-foreground [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-10 [&_h2]:mb-4 [&_strong]:text-foreground">
          <h2>Agreement</h2>
          <p>By using PageAlert (&ldquo;the Service&rdquo;), you agree to these terms. If you don&apos;t agree, please don&apos;t use the Service.</p>

          <h2>What PageAlert does</h2>
          <p>PageAlert is a web monitoring service that checks publicly accessible websites on your behalf and notifies you when specified conditions are met. We use AI to extract and understand web page content.</p>

          <h2>Your account</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>You must provide accurate information when creating an account</li>
            <li>You are responsible for keeping your account secure</li>
            <li>You must be at least 16 years old to use the Service</li>
            <li>One account per person — don&apos;t create multiple accounts to bypass limits</li>
          </ul>

          <h2>Acceptable use</h2>
          <p>You agree not to:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li>Use the Service to monitor websites in violation of their terms of service</li>
            <li>Use the Service for any illegal purpose</li>
            <li>Attempt to overload, disrupt, or reverse-engineer the Service</li>
            <li>Monitor websites that contain illegal content</li>
            <li>Resell access to the Service without permission</li>
            <li>Use the Service to scrape data for purposes other than personal monitoring</li>
          </ul>

          <h2>Website monitoring</h2>
          <p>PageAlert accesses publicly available web pages using automated tools. We respect <code>robots.txt</code> directives where practical and rate-limit our requests. However, we cannot guarantee that every website owner will permit automated access. If a website blocks our scraper, we will mark the monitor as errored.</p>

          <h2>AI and data accuracy</h2>
          <p>PageAlert uses AI to extract data from web pages. While we strive for accuracy, AI extraction is not perfect. We do not guarantee that every match or data point will be 100% accurate. Always verify important information directly on the source website.</p>

          <h2>Subscriptions and billing</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>Free accounts have limited features (3 monitors, 6-hour checks)</li>
            <li>Paid subscriptions are billed monthly via Polar</li>
            <li>You can cancel at any time — access continues until the end of the billing period</li>
            <li>Refunds are handled on a case-by-case basis — contact us</li>
            <li>We may change pricing with 30 days notice</li>
          </ul>

          <h2>Service availability</h2>
          <p>We aim for high availability but do not guarantee 100% uptime. We may perform maintenance, update features, or experience outages. We will notify users of planned downtime where possible.</p>

          <h2>Termination</h2>
          <p>We may suspend or terminate accounts that violate these terms. You can delete your account at any time from Settings, which permanently removes all your data.</p>

          <h2>Limitation of liability</h2>
          <p>PageAlert is provided &ldquo;as is&rdquo; without warranty. We are not liable for missed notifications, inaccurate data extraction, or any losses resulting from use of the Service. Our maximum liability is limited to the amount you have paid for the Service in the past 12 months.</p>

          <h2>Changes to these terms</h2>
          <p>We may update these terms. Significant changes will be communicated via email or an in-app notice. Continued use after changes constitutes acceptance.</p>

          <h2>Governing law</h2>
          <p>These terms are governed by the laws of the United Kingdom.</p>

          <h2>Contact</h2>
          <p>Questions about these terms? Email <a href="mailto:legal@pagealert.io" className="text-primary hover:underline">legal@pagealert.io</a>.</p>
        </div>
      </main>
    </div>
  );
}
