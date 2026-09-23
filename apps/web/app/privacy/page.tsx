import type { Metadata } from "next";
import Link from "next/link";
import { Radar } from "lucide-react";
import { AnalyticsToggle } from "@/components/prowl/analytics-toggle";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "What PageAlert collects, who processes it, how long it is kept, and how to delete it or turn analytics off.",
  alternates: { canonical: "https://pagealert.io/privacy" },
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
        <p className="text-sm text-muted-foreground mb-12">Last updated: September 2026</p>

        <div className="prose prose-invert prose-sm max-w-none space-y-8 text-muted-foreground [&_h2]:text-foreground [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-10 [&_h2]:mb-4 [&_strong]:text-foreground">
          <h2>Who we are</h2>
          <p>PageAlert is run by <strong>J M Dimonaco LTD</strong>, a company registered in England and Wales (company number [COMPANY NUMBER], registered office [REGISTERED OFFICE ADDRESS]). We are the data controller for everything described here. Questions about your data go to <a href="mailto:dimonaco.james@gmail.com" className="text-primary hover:underline">dimonaco.james@gmail.com</a>.</p>

          <h2>What we collect</h2>
          <p><strong>Your account.</strong> Your <strong>email address</strong> and <strong>name</strong> — from Google or GitHub if you sign in that way, or as you typed them if you signed up with a password. A password is stored hashed; we cannot read it. We use these to sign you in and to email you.</p>
          <p><strong>Your monitors.</strong> The <strong>URLs</strong> you give us, your <strong>search prompts</strong>, and what we find on each check. Every check is logged — when it ran, what we read from the page, and whether it matched. That log is the check history you see in the dashboard.</p>
          <p><strong>Trying it before you sign up.</strong> A scan run without an account stores the URL and prompt for 7 days. If you leave an email address so we can tell you about matches, we keep the address with the scan for 30 days. Sign up with that address and the monitor moves into your account.</p>
          <p><strong>Notification channels.</strong> If you connect one, we store your <strong>Telegram chat ID</strong> or <strong>Discord webhook URL</strong>. For browser push we store a subscription address and keys for each device you allow it on, along with that browser&apos;s user agent string.</p>
          <p><strong>Feedback and reviews.</strong> A thumbs up or down on an alert is stored with the entry it was about and the prompt you had at the time. If you leave a review, the display name and words you give us are shown on our homepage.</p>
          <p><strong>Emails we send you.</strong> One record per email: the address, what kind of email it was, and whether it was delivered, bounced, or marked as spam.</p>
          <p><strong>Activity.</strong> When you were last in the app, and when you created each monitor.</p>
          <p><strong>Billing.</strong> Which plan you are on and your Polar customer and subscription IDs. Polar holds your payment details; we never see them.</p>
          <p><strong>Analytics.</strong> We use PostHog to record page views, clicks, feature use and errors. This is <strong>not anonymous</strong>: once you sign in, it is linked to your account, with your email, name, sign-up date and how many monitors you have, so we can see how people use the product. PostHog also records <strong>session replays</strong> — the pages you visit, where you click, and how you move through the app. Anything you type into a form is masked before it leaves your browser. Vercel Analytics separately counts page views and load times in aggregate.</p>

          <h2>How we use your data, and on what basis</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li><strong>To run the service</strong> — checking your pages, sending alerts by email and any channel you connect, and taking payment. This is needed to provide what you signed up for.</li>
            <li><strong>To email you about your account</strong> — a welcome email when you sign up, a notice if we pause your monitors, and the occasional account-wide notice. Same basis.</li>
            <li><strong>To improve the product</strong> — the analytics above. Our legitimate interest in understanding how the app is used. You can turn this off; see Cookies and analytics below.</li>
            <li><strong>To prevent abuse</strong> — a limit on how fast monitors can be created, one Telegram chat or Discord webhook per free account, and suspending accounts that break the terms. Our legitimate interest in keeping the service running for everyone.</li>
            <li><strong>To know whether our emails arrive</strong> — the delivery records above. Same legitimate interest.</li>
          </ul>
          <p>If you stop using the app and are on the free plan, we pause your monitors — after 30 days if an alert has gone unread, or after 90 days otherwise — and email you a link to restart them. This is so we are not checking pages nobody is reading.</p>

          <h2>Who else processes it</h2>
          <p>These services process your data on our behalf:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li><strong>Convex</strong> — database and backend. Everything above is stored here.</li>
            <li><strong>Anthropic (Claude)</strong> — the text of each page we check is sent to Claude, with your prompt, to pull out the entries and judge whether they match.</li>
            <li><strong>Scrapfly</strong> — when a site blocks us, we fetch the page through Scrapfly&apos;s proxy service instead. They see the URL and return the page.</li>
            <li><strong>Resend</strong> — sends our email and tells us when one bounces.</li>
            <li><strong>Polar</strong> — payments and subscriptions.</li>
            <li><strong>PostHog</strong> — analytics and session replay, hosted in the United States.</li>
            <li><strong>Vercel</strong> — hosts the site and provides the aggregate page analytics.</li>
            <li><strong>Railway</strong> — hosts the scraper that fetches pages.</li>
            <li><strong>Telegram and Discord</strong> — if you connect them, alerts go through their APIs. Telegram receives your chat ID and each message; Discord receives each message at the webhook URL you gave us.</li>
          </ul>
          <p>Several of these providers are in the United States, so some of your data leaves the UK. Each one processes it under its own data processing terms. We do not sell your data to anyone.</p>

          <h2>Cookies and analytics</h2>
          <p>We use an essential cookie to keep you signed in. PostHog stores an identifier in a cookie and in local storage so it can tell one visit from the next.</p>
          <p>Analytics requests go through our own domain, so a browser ad blocker may not stop them. Turn them off here — no account needed, because we start recording on the pages you can reach without one. The same switch is in <strong>Settings → Profile → Analytics</strong> once you have signed in.</p>

          <div className="not-prose rounded-lg border border-border/40 bg-card/50 p-4">
            <AnalyticsToggle />
          </div>

          <h2>How long we keep it</h2>
          <p>Everything tied to your account is kept while the account exists, including your full check history. Scans run without an account are deleted after 7 days, or 30 days if you left an email address.</p>
          <p>You can delete your account from <strong>Settings → Profile</strong>. That removes your monitors, results, check history, notifications, connected channels, push subscriptions, feedback, reviews, email delivery records, and the login itself, including your email and name. The check history is cleared in the background and is gone within a few minutes.</p>
          <p>Three things stay after deletion: if your account was suspended, the record of the suspension; the record of any account-wide email we sent, which lists the addresses it went to; and the IDs of Polar orders we have applied, alongside Polar&apos;s own record of your payments. A suspended account cannot be deleted from Settings — email us instead.</p>

          <h2>Your rights</h2>
          <p>Under UK data protection law you can:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li><strong>Access</strong> your data — your monitors, results and check history are all in the dashboard. Email us for anything else.</li>
            <li><strong>Correct</strong> it — email us and we will fix it.</li>
            <li><strong>Delete</strong> it — delete individual monitors or your whole account from Settings.</li>
            <li><strong>Export</strong> it — email us and we will send you a copy.</li>
            <li><strong>Object</strong> to analytics — use the switch above, or the one in Settings.</li>
            <li><strong>Complain</strong> to the Information Commissioner&apos;s Office at <a href="https://ico.org.uk" className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">ico.org.uk</a> if you think we have handled your data badly. We would rather hear from you first.</li>
          </ul>

          <h2>Security</h2>
          <p>All traffic uses HTTPS. Sign-in is handled by Better Auth, with Google, GitHub, or an email address and a hashed password. Our infrastructure providers encrypt data at rest.</p>

          <h2>Changes to this policy</h2>
          <p>If we make a significant change, we will email you or show a notice in the app.</p>

          <h2>Contact</h2>
          <p>Email <a href="mailto:dimonaco.james@gmail.com" className="text-primary hover:underline">dimonaco.james@gmail.com</a>.</p>
        </div>

        <div className="mt-12 pt-8 border-t border-border/20">
          <Link href="/" className="text-sm text-primary hover:underline">&larr; Back to PageAlert</Link>
        </div>
      </main>
    </div>
  );
}
