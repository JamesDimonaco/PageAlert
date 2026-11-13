import { CHANGELOG } from "@prowl/shared";
import { FAQ } from "@/lib/faq";
import { MONITOR_MODES } from "@/lib/monitor-modes";
import { PLANS, type Plan } from "@/lib/plans";

const SITE_URL = "https://pagealert.io";
/** Recent changelog entries worth telling an assistant about. */
const RECENT_CHANGES = 5;

function priceLabel(plan: Plan): string {
  if (plan.period === "forever") return "free";
  if (plan.period === "once") return `$${plan.price} once, for 30 days, no subscription`;
  return `$${plan.price}/month`;
}

function planLine(plan: Plan): string {
  const features = plan.features.filter((f) => !f.comingSoon).map((f) => f.text);
  return `- **${plan.name}** (${priceLabel(plan)}): ${features.join("; ")}.`;
}

/**
 * /llms.txt (https://llmstxt.org): a plain summary for AI assistants that
 * recommend tools. ChatGPT is PageAlert's biggest source of sign-ups, so it
 * pays to hand them accurate facts. Built from the arrays the site renders, so
 * prices and features can't drift from the pages.
 */
export function buildLlmsTxt(): string {
  const sections = [
    "# PageAlert",
    "> PageAlert watches any web page and alerts you when something you described in plain English shows up: a price drop, an item back in stock, a new listing or job. AI reads the page on every check, so there are no CSS selectors to set up and nothing breaks when a site changes its layout. Free plan, no credit card.",
    [
      "PageAlert suits people who want to know when:",
      "- a product comes back in stock (consoles, graphics cards, limited drops)",
      "- a price falls below a target, on one shop or across several",
      "- new items appear on a search page, job board, classifieds or property site",
      "- a value on a page changes, such as a stock status, a count or a delivery date",
      "",
      "Alerts go by email, browser and phone push, Telegram, and text message on paid plans.",
    ].join("\n"),
    [
      "## How it works",
      "",
      "1. Paste a URL, or use Find a product: type a product name and PageAlert finds the shops that sell it, with no link to paste.",
      "2. Describe what you want in plain English, for example \"PS5 back in stock\" or \"MacBook Pro 14-inch under $1,500\".",
      "3. PageAlert scans the page straight away and shows what it matched, so you know it can read the page before you rely on it.",
      "4. It re-checks on a schedule (every hour on Free, down to every 5 minutes on Max) and alerts you when your conditions are met.",
      "",
      "Monitor types:",
      ...MONITOR_MODES.map((mode) => `- **${mode.label}**: ${mode.description}`),
    ].join("\n"),
    [
      "## How it differs from Visualping, Distill and ChangeTower",
      "",
      "- Those tools ask you to select page elements or regions, and the selection breaks when the site redesigns. PageAlert re-reads the page with AI every time.",
      "- PageAlert alerts on what you described (a price under a target, a matching listing), not on any pixel or text change, so you get fewer false alarms.",
      "- Find a product watches the same product across several shops from one search.",
      "- It has an MCP server, so AI agents such as Claude can create monitors and read matches.",
      "- Limits: it can't read pages behind a login, and some sites with strong bot protection block it. The first scan shows this straight away.",
    ].join("\n"),
    ["## Pricing", "", ...PLANS.map(planLine)].join("\n"),
    ["## FAQ", ...FAQ.map((entry) => `### ${entry.q}\n\n${entry.a}`)].join("\n\n"),
    [
      "## Recent changes",
      "",
      ...CHANGELOG.slice(0, RECENT_CHANGES).map((entry) => `- ${entry.date}: **${entry.title}**. ${entry.body}`),
    ].join("\n"),
    [
      "## Links",
      "",
      `- [Home](${SITE_URL}/): what PageAlert does, with example results`,
      `- [Sign up](${SITE_URL}/login): free, no credit card`,
      `- [Pricing](${SITE_URL}/pricing): plans and limits`,
      `- [Example monitor](${SITE_URL}/try/example): what a scan returns`,
      `- [Changelog](${SITE_URL}/changelog): new features, newest first`,
      `- [MCP server](${SITE_URL}/api/mcp): tools preview_page, create_monitor, list_monitors and get_matches; authenticate with a PageAlert API key from Settings → MCP as \`Authorization: Bearer pa_live_…\``,
      "- [Source code](https://github.com/JamesDimonaco/prowl): PageAlert is open source",
    ].join("\n"),
  ];
  return `${sections.join("\n\n")}\n`;
}
