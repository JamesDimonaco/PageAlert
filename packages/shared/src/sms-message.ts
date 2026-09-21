/**
 * SMS bodies, built to fit one message.
 *
 * Unlike every other channel, length here is money. A body of 160 GSM-7
 * characters is one segment; 161 is two, and Twilio bills per segment. Worse,
 * a single character outside the GSM-7 alphabet — a curly quote pasted from a
 * shop listing, an emoji in a monitor name — switches the whole message to
 * UCS-2, where the limit drops to 70 and a normal alert becomes three
 * segments. So every string is transliterated into GSM-7 first, then the
 * variable part is truncated against the space actually left.
 */

/** Characters in the GSM 03.38 basic alphabet. One septet each. */
const GSM7_BASIC = new Set(
  "@£$¥èéùìòÇ\nØø\rÅå" +
    "Δ_ΦΓΛΩΠΨΣΘΞ" +
    "ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
    "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§" +
    "¿abcdefghijklmnopqrstuvwxyzäöñüà"
);

/** Escape-prefixed characters. Two septets each, so they cost double. */
const GSM7_EXTENDED = new Set("^{}\\[~]|€");

/**
 * Characters that are not GSM-7 but have an obvious plain equivalent. Monitor
 * names come from whatever the user typed and whatever they pasted out of a
 * retailer's page, so smart quotes, dashes and exotic spaces turn up
 * constantly. Letters already in the basic alphabet are absent on purpose —
 * the lookup below only runs once the alphabet check has missed.
 */
const TRANSLITERATIONS: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  "–": "-", "—": "-", "―": "-", "−": "-",
  "…": "...",
  " ": " ", " ": " ", " ": " ", "​": "",
  "´": "'", "`": "'",
  "×": "x", "•": "-", "·": "-",
  "ç": "c",
};

/** The width of one segment. */
export const GSM7_SEGMENT_LIMIT = 160;

/** Septets `text` occupies. Extended characters cost two. */
export function gsm7Length(text: string): number {
  let n = 0;
  for (const ch of text) n += GSM7_EXTENDED.has(ch) ? 2 : 1;
  return n;
}

/**
 * Rewrite `text` so every character is GSM-7. Anything without a sensible
 * equivalent is dropped rather than replaced with a placeholder — a name full
 * of "?" reads as corruption, a name with the emoji missing reads as the name.
 */
export function toGsm7(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    if (GSM7_BASIC.has(ch) || GSM7_EXTENDED.has(ch)) {
      out += ch;
      continue;
    }
    const swap = TRANSLITERATIONS[ch];
    if (swap !== undefined) {
      out += swap;
      continue;
    }
    // Strip the accent and retry, so "Zoë" survives as "Zoe" rather than "Zo".
    const stripped = ch.normalize("NFD").replace(/\p{Diacritic}/gu, "");
    if (stripped.length === 1 && GSM7_BASIC.has(stripped)) out += stripped;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Cut `text` to at most `budget` septets, marking the cut when there is room. */
function fit(text: string, budget: number): string {
  if (budget <= 0) return "";
  if (gsm7Length(text) <= budget) return text;

  // Below four septets there is no room for both content and a ".." marker, so
  // take whatever fits and let it end mid-word.
  const marker = budget >= 4 ? ".." : "";
  const room = budget - marker.length;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const cost = GSM7_EXTENDED.has(ch) ? 2 : 1;
    if (used + cost > room) break;
    out += ch;
    used += cost;
  }
  return `${out.trimEnd()}${marker}`;
}

/**
 * Assemble `prefix + variable + suffix` so the result is one segment, giving
 * the variable part whatever room the fixed parts leave.
 */
function oneSegment(prefix: string, variable: string, suffix: string): string {
  const fixed = gsm7Length(prefix) + gsm7Length(suffix);
  return `${prefix}${fit(variable, GSM7_SEGMENT_LIMIT - fixed)}${suffix}`;
}

export interface MatchSmsArgs {
  monitorName: string;
  /** Entries the user has not been told about yet. */
  newCount: number;
  /** Short link to the monitor, already built by the caller. */
  link: string;
}

export function formatMatchSms({ monitorName, newCount, link }: MatchSmsArgs): string {
  const plural = newCount === 1 ? "" : "es";
  return oneSegment(
    `PageAlert: ${newCount} new match${plural} on "`,
    toGsm7(monitorName),
    `" ${toGsm7(link)}`
  );
}

export interface PriceSmsArgs {
  monitorName: string;
  variant: "threshold" | "single_drop" | "multiple";
  changes: Array<{ title: string; oldPrice: number; newPrice: number; changePercent: number }>;
  link: string;
}

export function formatPriceSms({ monitorName, variant, changes, link }: PriceSmsArgs): string {
  const first = changes[0];
  const tail = ` ${toGsm7(link)}`;

  // With one item there is room to name the price, which is the whole point of
  // the alert. With several there is not, so the count carries it instead.
  if (first && (variant === "threshold" || variant === "single_drop" || changes.length === 1)) {
    const money = `$${first.newPrice.toFixed(2)} (was $${first.oldPrice.toFixed(2)})`;
    const lead = variant === "threshold" ? "PageAlert: price target hit - " : "PageAlert: ";
    return oneSegment(lead, toGsm7(first.title), ` now ${money}${tail}`);
  }

  const n = changes.length;
  return oneSegment(
    `PageAlert: ${n} price change${n === 1 ? "" : "s"} on "`,
    toGsm7(monitorName),
    `"${tail}`
  );
}

/**
 * The last SMS of the period. Sent once, when the allowance runs out, so the
 * silence that follows is explained rather than read as the product failing.
 */
export function formatQuotaExhaustedSms(limit: number, link: string): string {
  return oneSegment(
    `PageAlert: that used the last of your ${limit} texts this month. Alerts come by email until it resets. `,
    "",
    toGsm7(link)
  );
}

/** The verification code, and the only place the opt-out route is spelled out. */
export function formatVerificationSms(code: string): string {
  return `PageAlert: your code is ${code}. It expires in 10 minutes. Turn texts off any time in your dashboard settings.`;
}
