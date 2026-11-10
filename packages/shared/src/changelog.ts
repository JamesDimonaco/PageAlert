import { HISTORY_WINDOW_DAYS as days } from "./retention";

export interface ChangelogEntry {
  /** What a dismissed popup records. Never reuse or change one, or the entry pops up again. */
  id: string;
  /** YYYY-MM-DD, UTC: the day it ships. Accounts created on or after this day never get the popup for it. */
  date: string;
  title: string;
  body: string;
  cta?: { label: string; href: string };
  /** No popup for users who had already switched this beta on: they know the feature. */
  skipIfBetaOn?: "find_a_product";
}

/**
 * The public /changelog page, newest first. The first entry is also the
 * dashboard popup: adding one at the top shows it once to every existing user.
 */
export const CHANGELOG: readonly ChangelogEntry[] = [
  {
    id: "find-a-product",
    date: "2026-11-09",
    title: "New feature available: Find a product",
    body: "Type a product name and we'll find the shops that sell it. Pick the ones to watch, with no link to paste. It's still in beta, so tell us if anything looks off.",
    cta: { label: "Try it now", href: "/dashboard?new=1" },
    skipIfBetaOn: "find_a_product",
  },
  {
    id: "find-a-product-beta",
    date: "2026-11-06",
    title: "New beta: Find a product",
    body: "Type a product name and pick the shops to watch, with no link to paste. It's an early version, so expect rough edges.",
  },
  {
    id: "sms-alerts",
    date: "2026-10-06",
    title: "PageAlert can now text you",
    body: "Get a text when a monitor finds a match or a price drops. Texts come with every paid plan.",
    cta: { label: "Set up texts", href: "/dashboard/settings?tab=notifications#sms" },
  },
  {
    id: "mcp-server",
    date: "2026-09-30",
    title: "Create monitors from Claude and other AI agents",
    body: "PageAlert now has an MCP server. Make an API key in Settings, connect your agent, and it can create monitors and read their matches.",
    cta: { label: "Get an API key", href: "/dashboard/settings?tab=api" },
  },
  {
    id: "session-link-warning",
    date: "2026-09-26",
    title: "A warning for links that won't last",
    body: "Some links only work in the browser session that made them, such as ones carrying a session ID or a signed token. The new-monitor form now warns you when a link looks like one.",
  },
  {
    id: "push-test-help",
    date: "2026-09-24",
    title: "Help when a test alert doesn't show",
    body: "If a test notification never appears, Settings now walks you through the browser and system settings that block it. You can also scan a QR code to turn on alerts on your phone.",
  },
  {
    id: "history-by-plan",
    date: "2026-09-23",
    title: "Check history by plan",
    body: `Logs show ${days.free} days of checks on Free, ${days.sprint} on Sprint, ${days.pro} on Pro and ${days.max} on Max. Older checks are kept, so upgrading brings them back.`,
  },
  {
    id: "discord-matches-first",
    date: "2026-09-15",
    title: "Discord alerts, and matches up front",
    body: "Discord is on as an alert channel. A monitor's page now opens on its matches, with the new ones marked.",
  },
  {
    id: "push-hourly-sprint",
    date: "2026-09-09",
    title: "Phone alerts, hourly checks on Free, and the Sprint pass",
    body: "Alerts can now go straight to your phone or browser. Free monitors check every hour instead of every 6. The Sprint pass gives you 30 days of a paid plan for a one-off payment, with no subscription.",
  },
];

export function latestChangelogEntry(): ChangelogEntry {
  return CHANGELOG[0];
}
