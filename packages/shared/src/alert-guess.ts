import { currencyExponent } from "./money";

export interface GuessedAlertOn {
  backInStock: boolean;
  priceDrop: boolean;
  /**
   * The target in major units (300 for "under £300"). Currency is null when
   * the prompt only has a shared symbol, which is then in `symbol`. `written`
   * is the price as the prompt put it, for showing back to the user.
   */
  priceBelow: { amount: number; currency: string | null; symbol: string | null; written: string } | null;
}

const SYMBOLS: Record<string, string | null> = {
  "£": "GBP",
  "€": "EUR",
  "₹": "INR",
  "US$": "USD",
  "CA$": "CAD",
  "C$": "CAD",
  "AU$": "AUD",
  "A$": "AUD",
  "NZ$": "NZD",
  // Several currencies share these.
  $: null,
  "¥": null,
};

const BELOW =
  /\b(?:under|below|less than|cheaper than)\s+(?:([a-z]{3})\s*)?(US\$|CA\$|AU\$|NZ\$|C\$|A\$|[£€₹$¥])?\s*(\d[\d,]*(?:\.\d+)?)(?:\s*([a-z]{3})\b)?/gi;

// Restock intent only. "available in size M" or "out of stock" say nothing
// about wanting a restock alert.
const RESTOCK =
  /\b(?:back in stock|restock(?:s|ed|ing)?|in stock again|comes? back|when (?:it['’]?s |it is )?(?:available|in stock))\b/i;
const NEGATED = /\b(?:not|no longer|never|isn['’]?t)\s+(?:back\s+)?(?:in stock|available)\b/i;

// "cheaper than" is a target, read below. It never means any drop.
const DROP = /\b(?:price (?:drops?|falls?|goes down)|cheaper(?!\s+than)|(?:goes )?on sale)\b/i;

// Upper case only: in lower case, "all", "cup" and "top" are currencies too.
function codeOrNull(code: string | undefined): string | null {
  if (!code || code !== code.toUpperCase()) return null;
  return currencyExponent(code) === null ? null : code;
}

function readTarget(prompt: string): GuessedAlertOn["priceBelow"] {
  for (const [, codeBefore, symbol, digits, codeAfter] of prompt.matchAll(BELOW)) {
    const code = codeOrNull(codeBefore) ?? codeOrNull(codeAfter);
    // Without a currency, "under 10" could be a shoe size or grams, so keep looking.
    if (!symbol && !code) continue;
    const currency = code ?? SYMBOLS[symbol.toUpperCase()] ?? null;
    return {
      amount: Number(digits.replace(/,/g, "")),
      currency,
      symbol: currency ? null : symbol,
      written: code ? `${digits} ${code}` : `${symbol}${digits}`,
    };
  }
  return null;
}

/**
 * Guesses alert criteria from a monitor's plain-English prompt, so a clone can
 * start a product with them. Only reads what the prompt says outright; the
 * user can change every guess.
 */
export function guessAlertOn(prompt: string): GuessedAlertOn {
  const priceBelow = readTarget(prompt);
  return {
    backInStock: RESTOCK.test(prompt) && !NEGATED.test(prompt),
    priceDrop: !priceBelow && DROP.test(prompt),
    priceBelow,
  };
}
