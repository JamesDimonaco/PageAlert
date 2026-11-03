import { currencyExponent } from "./money";

export interface GuessedAlertOn {
  backInStock: boolean;
  priceDrop: boolean;
  /**
   * The target as written, in major units (300 for "under £300"). Currency is
   * null when the prompt only has an ambiguous symbol such as "$".
   */
  priceBelow: { amount: number; currency: string | null } | null;
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
  /\b(?:under|below|less than|cheaper than)\s+(?:([a-z]{3})\s*)?(US\$|CA\$|AU\$|NZ\$|C\$|A\$|[£€₹$¥])?\s*(\d[\d,]*(?:\.\d+)?)(?:\s*([a-z]{3})\b)?/i;

// Upper case only: in lower case, "all", "cup" and "top" are currencies too.
function codeOrNull(code: string | undefined): string | null {
  if (!code || code !== code.toUpperCase()) return null;
  return currencyExponent(code) === null ? null : code;
}

/**
 * Guesses alert criteria from a monitor's plain-English prompt, so a clone can
 * start a product with them. Only reads what the prompt says outright; the
 * user can change every guess.
 */
export function guessAlertOn(prompt: string): GuessedAlertOn {
  const backInStock = /\b(?:in stock|restock(?:s|ed|ing)?|available)\b/i.test(prompt);
  const priceDrop = /\b(?:price drops?|cheaper)\b/i.test(prompt);

  let priceBelow: GuessedAlertOn["priceBelow"] = null;
  const m = BELOW.exec(prompt);
  if (m) {
    const [, codeBefore, symbol, digits, codeAfter] = m;
    const code = codeOrNull(codeBefore) ?? codeOrNull(codeAfter);
    // Without a currency, "under 300" could be grams or pixels.
    if (symbol || code) {
      priceBelow = {
        amount: Number(digits.replace(/,/g, "")),
        currency: code ?? (symbol ? SYMBOLS[symbol.toUpperCase()] ?? null : null),
      };
    }
  }

  return { backInStock, priceDrop: priceDrop && !priceBelow, priceBelow };
}
