import type { Metadata } from "next";
import Link from "next/link";
import { Radar } from "lucide-react";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms and conditions for using PageAlert — AI-powered website monitoring. Covers acceptable use, billing, data accuracy, and liability.",
  alternates: { canonical: "https://pagealert.io/terms" },
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
        <p className="text-sm text-muted-foreground mb-12">Last updated: September 2026</p>

        <div className="prose prose-invert prose-sm max-w-none space-y-8 text-muted-foreground [&_h2]:text-foreground [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-10 [&_h2]:mb-4 [&_strong]:text-foreground">
          <h2>Agreement</h2>
          <p>By using PageAlert (&ldquo;the Service&rdquo;), you agree to these terms. If you don&apos;t agree, please don&apos;t use the Service. The Service is provided by J M Dimonaco LTD (&ldquo;we&rdquo;, &ldquo;us&rdquo;).</p>

          <h2>What PageAlert does</h2>
          <p>PageAlert is a web monitoring service that checks publicly accessible websites on your behalf and notifies you when specified conditions are met. We use AI to extract and understand web page content.</p>

          <h2>Trying it without an account</h2>
          <p>You can run a scan from the homepage without signing up. It is kept for 7 days, or 30 days if you leave an email address to be told about matches, and then deleted. We limit how many of these scans run each day. Sign up with the same email address and the scan becomes a monitor on your account.</p>

          <h2>Your account</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>You must provide accurate information when creating an account</li>
            <li>You are responsible for keeping your account secure</li>
            <li>You must be at least 16 years old to use the Service</li>
            <li>One account per person — don&apos;t create multiple accounts to bypass limits</li>
            <li>On the free plan, a Telegram chat or Discord webhook can be connected to one account at a time</li>
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
          <p>PageAlert reads publicly available web pages using automated tools, at the interval you choose within your plan&apos;s limits. We cannot guarantee that every website will permit automated access. Some sites block us; when that happens we may fetch the page through a proxy service (Scrapfly) instead. If a site keeps blocking us, we stop checking that monitor and tell you.</p>

          <h2>AI and data accuracy</h2>
          <p>PageAlert uses AI to extract data from web pages. While we strive for accuracy, AI extraction is not perfect. We do not guarantee that every match or data point will be 100% accurate. Always verify important information directly on the source website.</p>

          <h2>Plans and billing</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>The free plan includes 3 monitors, hourly checks, email and push alerts, and Telegram or Discord on one monitor</li>
            <li>Pro and Max are monthly subscriptions, billed through Polar. You can cancel at any time — access continues until the end of the billing period</li>
            <li>Sprint is a single payment for 30 days of access. It is not a subscription: there is nothing to cancel, it expires on its own, and buying another adds 30 more days</li>
            <li>Refunds are handled on a case-by-case basis — contact us</li>
            <li>We may change pricing with 30 days notice</li>
          </ul>

          <h2>Inactive accounts</h2>
          <p>If you are on the free plan and stop using the app, we pause your monitors — after 30 days if an alert has gone unread, or after 90 days otherwise. We email you a link that restarts them, and signing in works too. Paid plans are not paused this way.</p>

          <h2>Reviews</h2>
          <p>If you leave a review, we may show the display name and words you gave us on our homepage. Email us if you want it taken down.</p>

          <h2>Service availability</h2>
          <p>We aim for high availability but do not guarantee 100% uptime. We may perform maintenance, update features, or experience outages. We will notify users of planned downtime where possible.</p>

          <h2>Suspension and termination</h2>
          <p>We may suspend or terminate accounts that violate these terms. A suspended account cannot be deleted from Settings — email us and we will delete it. Otherwise you can delete your account at any time from Settings, which permanently removes your data as described in the <Link href="/privacy" className="text-primary hover:underline">privacy policy</Link>.</p>

          <h2>Limitation of liability</h2>
          <p>PageAlert is provided &ldquo;as is&rdquo; without warranty. We are not liable for missed or delayed notifications, inaccurate data extraction, a website blocking our access, a messaging service failing to deliver, or any losses resulting from use of the Service. Our maximum liability is limited to the amount you have paid for the Service in the past 12 months.</p>

          <h2>Changes to these terms</h2>
          <p>We may update these terms. Significant changes will be communicated via email or an in-app notice. Continued use after changes constitutes acceptance.</p>

          <h2>Governing law</h2>
          <p>These terms are governed by the laws of England and Wales, and any dispute will be dealt with by the courts of England and Wales.</p>

          <h2>Contact</h2>
          <p>Questions about these terms? Email <a href="mailto:dimonaco.james@gmail.com" className="text-primary hover:underline">dimonaco.james@gmail.com</a>.</p>
        </div>

        <div className="mt-12 pt-8 border-t border-border/20">
          <Link href="/" className="text-sm text-primary hover:underline">&larr; Back to PageAlert</Link>
        </div>
      </main>
    </div>
  );
}
