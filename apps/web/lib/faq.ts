export interface FaqEntry {
  q: string;
  a: string;
}

/**
 * One source for the FAQ. The landing page renders these and the root layout
 * turns them into FAQPage JSON-LD — keeping both from the same array so the
 * page and the structured data can't drift apart.
 */
export const FAQ: FaqEntry[] = [
  {
    q: "How does PageAlert work?",
    a: "Paste a URL and describe what you're looking for in plain English, like 'MacBook Pro under £1500'. AI reads the page, works out its structure, and pulls out the data. From then on PageAlert re-checks on your schedule and emails you when your conditions are met.",
  },
  {
    q: "What kind of websites can I monitor?",
    a: "Product pages, stock listings, job boards, classified ads, real estate, auction sites — anything with data on it. Some pages we can't reach: anything behind a login, sites with strong bot protection, and a few apps that only load content after you interact with them. You'll find out on the first scan rather than weeks later, and we'll tell you when a page starts blocking us.",
  },
  {
    q: "Do I need to know CSS selectors or coding?",
    a: "No. Tools like Visualping and Distill ask you to click page elements, and those break when a site changes its layout. PageAlert re-reads the page with AI every time — nothing to maintain, nothing to fix after a redesign.",
  },
  {
    q: "How often does PageAlert check my pages?",
    a: "Free accounts check every 6 hours, Pro every 15 minutes, and Max every 5 minutes. You pick the frequency per monitor, so a page that rarely changes doesn't have to be checked as often as one that does.",
  },
  {
    q: "How will I be notified when something changes?",
    a: "Email on every plan. Telegram and Discord can be connected on any plan too, though free accounts can only point one monitor at them. Alerts say what matched, what the price did, and link straight to the item.",
  },
  {
    q: "Is there a free plan?",
    a: "Yes — 3 monitors, 6-hour checks, email notifications, no credit card.",
  },
  {
    q: "What happens when my plan ends?",
    a: "Your monitors and their history stay where they are. You go back to free limits, so you can't create new monitors past the free cap or pick a faster check interval until you upgrade again.",
  },
  {
    q: "What do you do with my data?",
    a: "We store the data we extract from the pages you monitor, so we can tell what changed between checks, along with your email address and notification settings. We don't sell it and we don't use it for advertising. Delete a monitor and its history goes with it.",
  },
];

/** Build FAQPage JSON-LD entries from the same array the page renders */
export function buildFaqJsonLd() {
  return FAQ.map((entry) => ({
    "@type": "Question" as const,
    name: entry.q,
    acceptedAnswer: {
      "@type": "Answer" as const,
      text: entry.a,
    },
  }));
}
