import type { Metadata } from "next";
import Link from "next/link";
import { Radar } from "lucide-react";

/**
 * The opt-in evidence carriers ask for.
 *
 * Toll-free and short-code registrations require "publicly hosted images or
 * URLs that show the full opt-in workflow and the text shown to the user". The
 * real flow sits behind a login, which a reviewer cannot pass, so this page is
 * what they read instead. Section 4 quotes the settings card verbatim — if that
 * wording changes, this changes with it or the submission stops matching the
 * product.
 *
 * Indexing is left on deliberately: a page a reviewer cannot find is no use,
 * and a noindex page reads as something being hidden.
 */
export const metadata: Metadata = {
  title: "SMS opt-in and messaging policy",
  description:
    "How PageAlert collects consent for text messages, what it sends, how often, and how to stop them. Prepared for carrier and aggregator review.",
  alternates: { canonical: "https://pagealert.io/sms-policy" },
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-2 sm:flex-row sm:gap-4 border-b border-border/20 last:border-0">
      <dt className="w-full shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground sm:w-56">
        {label}
      </dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

export default function SmsPolicyPage() {
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
        <h1 className="text-3xl font-bold tracking-tight mb-2">SMS opt-in and messaging policy</h1>
        <p className="text-sm text-muted-foreground mb-2">Prepared for carrier and aggregator review</p>
        <p className="text-sm text-muted-foreground mb-12">Version 1.1 — 26 September 2026</p>

        <div className="prose prose-invert prose-sm max-w-none space-y-8 text-muted-foreground [&_h2]:text-foreground [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-10 [&_h2]:mb-4 [&_strong]:text-foreground">
          <h2>1. Who we are</h2>
          <dl className="not-prose">
            <Row label="Legal entity">J M Dimonaco LTD</Row>
            <Row label="Registration">Companies House no. 14260548, England &amp; Wales</Row>
            <Row label="Registered address">34 Llanberis Close, Tonteg, Cardiff, CF38 1HR, United Kingdom</Row>
            <Row label="Trading name">PageAlert</Row>
            <Row label="Website"><a href="https://pagealert.io" className="text-primary hover:underline">pagealert.io</a></Row>
            <Row label="Privacy policy"><Link href="/privacy" className="text-primary hover:underline">pagealert.io/privacy</Link></Row>
            <Row label="Terms of service"><Link href="/terms" className="text-primary hover:underline">pagealert.io/terms</Link></Row>
            <Row label="Support contact"><a href="mailto:dimonaco.james@gmail.com" className="text-primary hover:underline">dimonaco.james@gmail.com</a></Row>
            <Row label="Messaging provider">Twilio Inc.</Row>
          </dl>

          <h2>2. What the service does</h2>
          <p>PageAlert is a web page monitoring service. A customer signs up, creates a &ldquo;monitor&rdquo; for a page they care about, and describes in their own words what they want to be told about — a visa appointment calendar where slots appear without warning, an airline&apos;s deals page, a retailer&apos;s listing for something out of stock, a council planning register.</p>
          <p>We fetch that page on a schedule the customer chooses, compare it to what we saw last time, and when something matching their description appears we send them an alert. The alert is the product: a customer who receives no alerts has received nothing of value.</p>

          <h2>3. Where SMS fits</h2>
          <p>SMS is one of five notification channels. The others are email, browser push, Telegram and Discord. Customers choose which channels each monitor uses, and most use email. SMS exists because email is easy to miss and the other three need an account or an app the general public does not have.</p>
          <p>Every text we send is one of exactly two things:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li>An alert about a change on a page the customer asked us to watch.</li>
            <li>A one-time numeric code, sent once, to check the customer owns the number they entered.</li>
          </ul>
          <p>We send no marketing, promotional offers, upsells, newsletters, surveys, political content, or messages on behalf of any third party.</p>

          <h2>4. How a customer opts in</h2>
          <p>Texts require two deliberate actions, both taken by the customer while signed in to their own account. Neither is a default, and neither is bundled with signing up or with accepting our terms.</p>

          <h3 className="text-foreground text-base font-semibold mt-6 mb-3">Step 1 — Agree to receive texts, and verify the number</h3>
          <p>In <strong>Settings → Notifications</strong> the customer finds a card headed &ldquo;Text message&rdquo;. This is the screen, verbatim:</p>

          <div className="not-prose rounded-lg border border-border/40 bg-card/50 p-5 space-y-4 text-sm">
            <div>
              <p className="font-semibold text-foreground">Text message</p>
              <p className="text-muted-foreground">Get a text when something changes</p>
            </div>
            <div className="space-y-1">
              <p className="font-medium text-foreground">Mobile number</p>
              <p className="rounded border border-border/40 px-3 py-2 text-muted-foreground">+44 7911 123456</p>
              <p className="text-xs text-muted-foreground">Start with your country code, not 0. UK, EU, US and Canada.</p>
            </div>
            <div className="flex items-start gap-2">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border text-[10px] text-muted-foreground">☐</span>
              <p className="text-xs text-muted-foreground leading-relaxed">
                I agree to receive <strong className="text-foreground">text messages</strong> from PageAlert
                about the pages I monitor. How many depends on the monitors I choose, up to my
                plan&apos;s limit. Message and data rates may apply. Reply STOP to a text to stop them,
                or turn them off here any time. See the <span className="text-primary">terms</span> and{" "}
                <span className="text-primary">privacy policy</span>.
              </p>
            </div>
            <p className="inline-block rounded border border-border px-3 py-1.5 text-xs text-foreground">Send me a code</p>
          </div>

          <p>The tick box is <strong>empty by default</strong> and &ldquo;Send me a code&rdquo; stays disabled until it is ticked. A customer can use every other part of PageAlert without ever ticking it.</p>
          <p>On pressing &ldquo;Send me a code&rdquo; we send exactly one message to that number:</p>
          <blockquote className="not-prose border-l-2 border-primary/40 pl-4 text-sm text-foreground">
            PageAlert: your code is 481920. It expires in 10 minutes. Turn texts off any time in your dashboard settings.
          </blockquote>
          <p>The card then asks for the code back, and the number becomes eligible to receive alerts only when the correct code is entered. A number that never returns a code never receives another message from us.</p>
          <p>Controls on this step:</p>
          <ul className="list-disc pl-6 space-y-2">
            <li>The code expires after 10 minutes, and the row holding it is deleted.</li>
            <li>Five incorrect attempts burn the code.</li>
            <li>An account may request at most 3 codes per day.</li>
            <li>The customer must be signed in. There is no anonymous path to this endpoint.</li>
            <li>On the free plan a number can be claimed by one account only, so the same number cannot be registered again and again.</li>
            <li>Destination countries are restricted to an explicit allowlist in our own code, and again at Twilio through geo permissions.</li>
          </ul>

          <h3 className="text-foreground text-base font-semibold mt-6 mb-3">Step 2 — Choose which monitors send texts</h3>
          <p>Verifying a number sends nothing on its own. Each monitor has its own channel selection, and SMS is <strong>off by default on every monitor</strong>, including ones created before the number was verified. A customer who verifies a number and does nothing else will never receive an alert by text.</p>

          <h2>5. How a customer opts out</h2>
          <dl className="not-prose">
            <Row label="Per monitor">Deselect the &ldquo;Text&rdquo; channel on that monitor.</Row>
            <Row label="Entirely">Settings → Notifications → Text message → &ldquo;Turn off&rdquo;. This deletes the stored number.</Row>
            <Row label="By reply">Reply STOP to any message.</Row>
            <Row label="Whole account">Deleting the account removes the number with it.</Row>
          </dl>
          <p>Opt-out takes effect immediately. Alerts continue on whichever other channels the customer chose, normally email, so stopping texts never silently stops the service they are paying for.</p>

          <h2>6. Keywords and automatic replies</h2>
          <dl className="not-prose">
            <Row label="HELP">PageAlert: alerts for web pages you monitor. Manage or stop texts at pagealert.io/dashboard/settings. Msg&amp;data rates may apply. Reply STOP to end.</Row>
            <Row label="START">PageAlert: you are subscribed to monitor alerts. Msg&amp;data rates may apply. Reply HELP for help, STOP to unsubscribe.</Row>
            <Row label="STOP">PageAlert: you are unsubscribed and will get no more texts. Reply START to resubscribe.</Row>
          </dl>

          <h2>7. Sample production messages</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li><strong>Several matches</strong> — PageAlert: 3 new matches on &ldquo;Ryanair Dublin deals&rdquo; https://pagealert.io/m/k17d8h2n4p9q3r5s7t1v6w8x0y2z4a6b</li>
            <li><strong>One match</strong> — PageAlert: 1 new match on &ldquo;Visa appointment slots&rdquo; https://pagealert.io/m/k17d8h2n4p9q3r5s7t1v6w8x0y2z4a6b</li>
            <li><strong>Price change</strong> — PageAlert: Sony WH-1000XM5 now $279.99 (was $379.00) https://pagealert.io/m/k17d8h2n4p9q3r5s7t1v6w8x0y2z4a6b</li>
            <li><strong>Verification code</strong> — PageAlert: your code is 481920. It expires in 10 minutes. Turn texts off any time in your dashboard settings.</li>
            <li><strong>Allowance used up</strong>, sent at most once a month — PageAlert: that was the last of your 10 texts this month. Alerts keep coming by email until it resets.</li>
          </ul>
          <p>Every message begins with the brand name, so the sender is never ambiguous, and each is composed to fit a single 160-character GSM-7 segment.</p>

          <h2>8. Message frequency</h2>
          <p>Frequency follows the customer&apos;s own monitors, so it varies. It is capped in the product, per customer, per calendar month and per day:</p>
          <div className="not-prose overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-4 font-medium">Plan</th>
                  <th className="py-2 pr-4 font-medium">Per month</th>
                  <th className="py-2 font-medium">Per day</th>
                </tr>
              </thead>
              <tbody className="text-foreground">
                {[["Free", "10", "3"], ["Sprint", "25", "10"], ["Pro", "60", "20"], ["Max", "200", "50"]].map(
                  ([plan, month, day]) => (
                    <tr key={plan} className="border-b border-border/20 last:border-0">
                      <td className="py-2 pr-4">{plan}</td>
                      <td className="py-2 pr-4">{month}</td>
                      <td className="py-2">{day}</td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
          <p>The daily cap exists so a page that starts changing erratically cannot produce a burst of messages. On reaching the monthly cap we send one message saying so and then stop; alerts continue by email until it resets. A separate ceiling applies across all customers combined — if it is reached, SMS stops entirely and every alert falls back to email.</p>

          <h2>9. What we never do</h2>
          <ul className="list-disc pl-6 space-y-2">
            <li>We never send marketing or promotional messages.</li>
            <li>We never send messages on behalf of a third party.</li>
            <li>We never sell, rent, share or licence phone numbers.</li>
            <li>We never buy, import or upload lists of numbers. Every number was typed in by its owner and confirmed by a code sent to it.</li>
            <li>We never send to a number that has not completed verification.</li>
            <li>We never enable texts on a monitor without the customer doing it.</li>
            <li>We send nothing in the categories carriers prohibit, including cannabis, CBD, firearms, gambling, high-risk lending, debt collection, adult content, and cryptocurrency promotion.</li>
          </ul>

          <h2>10. Data handling</h2>
          <dl className="not-prose">
            <Row label="What we store">The number in E.164 format, a flag saying it is verified, and the per-monitor channel choices. Message bodies are built at send time and not kept as a messaging history.</Row>
            <Row label="Where">Convex, EU region.</Row>
            <Row label="Verification codes">Held for at most 10 minutes, then deleted. Deleted immediately on success, and swept hourly if abandoned.</Row>
            <Row label="Retention">The number is held until the customer removes it or deletes their account, then deleted.</Row>
            <Row label="Access">The customer can see and remove their number at any time in Settings.</Row>
            <Row label="Processor">Twilio Inc. No other party receives the number.</Row>
            <Row label="Governing policy"><Link href="/privacy" className="text-primary hover:underline">pagealert.io/privacy</Link></Row>
          </dl>

          <h2>11. Eligibility and geography</h2>
          <p>The service is not directed at children, and customers must hold an account in their own name. Text destinations are restricted to an explicit allowlist enforced in our own code and again at Twilio through geo permissions. Any country not on that list is rejected before a message is composed.</p>

          <h2>12. Status</h2>
          <p>The SMS channel is built and waiting on carrier registration before being switched on for customers. The screens, controls and message text quoted above are the implemented behaviour, taken from the product itself, not a proposal.</p>
          <p><strong>No text message has been sent to any customer to date.</strong> The first production message will go out only once registration is approved.</p>
          <p>The above is an accurate description of how PageAlert collects consent and sends messages. — James Dimonaco, Director, J M Dimonaco LTD</p>
        </div>

        <div className="mt-12 pt-8 border-t border-border/20">
          <Link href="/" className="text-sm text-primary hover:underline">&larr; Back to PageAlert</Link>
        </div>
      </main>
    </div>
  );
}
