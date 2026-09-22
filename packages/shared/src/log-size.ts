
/**
 * Bounding a scrape log row.
 *
 * scrapeLogs is written by a public mutation, so every field on it is whatever
 * a signed-in client chose to send — and one of them is v.any(). The size of a
 * row is therefore not a fact about our scraper, it is a fact about whatever
 * the last caller posted, unless something here makes it one.
 *
 * It has to be made one, because the logs page reads whole rows and its page
 * size is calculated from what a row can cost. Bounding only the obvious field
 * and then quoting a row ceiling is how this got written wrong twice.
 */

/** Free text we keep for display: a URL, a prompt, an error, the AI's notes. */
export const MAX_LOG_TEXT_BYTES = 2_000;

/** The raw AI response, kept for debugging and shown only on the detail page. */
export const MAX_RAW_RESPONSE_BYTES = 32_000;

/** Generated match conditions — structured, so bounded by its serialised size. */
export const MAX_MATCH_CONDITIONS_BYTES = 4_000;

/** How many AI notices are worth keeping. */
export const MAX_LOG_NOTICES = 10;

/** A notice is one short sentence, so it gets less room than a prompt. */
export const MAX_LOG_NOTICE_BYTES = 500;

/** Caller-settable text fields capLogFields bounds to MAX_LOG_TEXT_BYTES. */
const CAPPED_TEXT_FIELDS = 9;

/**
 * What one scrape log row can cost to read, once capped.
 *
 * The nine text fields, the raw response, the match conditions, the notices,
 * and an allowance for keys, numbers and JSON punctuation. MAX_LIST_LIMIT in
 * convex/logs.ts is the query read budget divided by this, so the two move
 * together — and a test fails if capLogFields stops honouring it.
 */
export const MAX_LOG_ROW_BYTES =
  CAPPED_TEXT_FIELDS * MAX_LOG_TEXT_BYTES +
  MAX_RAW_RESPONSE_BYTES +
  MAX_MATCH_CONDITIONS_BYTES +
  MAX_LOG_NOTICES * MAX_LOG_NOTICE_BYTES +
  2_000;

/**
 * Truncates a string to `max` *bytes*, not characters.
 *
 * The distinction is the whole point: 50,000 characters of emoji is 200,000
 * bytes, so a character-counted limit bounds nothing you can budget against.
 * A cut landing mid-sequence leaves one replacement character, which is the
 * right trade for text nobody parses.
 */
export function capBytes(value: string, max: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= max) return value;
  return `${new TextDecoder().decode(bytes.slice(0, max))}…`;
}

/** Truncates the raw AI response to its own, larger budget. */
export function capRawResponse(raw: string | undefined): string | undefined {
  return raw === undefined ? undefined : capBytes(raw, MAX_RAW_RESPONSE_BYTES);
}

/** The subset of a scrape log whose size a caller controls. */
export interface CappableLogFields {
  url: string;
  prompt: string;
  error?: string;
  rawResponse?: string;
  monitorName?: string;
  aiUnderstanding?: string;
  aiMatchSignal?: string;
  aiNoMatchSignal?: string;
  aiNotices?: string[];
  matchConditions?: unknown;
  strategy?: string;
  blockReason?: string;
}

function capOptional(value: string | undefined, max: number): string | undefined {
  return value === undefined ? undefined : capBytes(value, max);
}

/**
 * Brings every caller-controlled field on a scrape log inside its budget, so
 * the row obeys MAX_LOG_ROW_BYTES whatever was posted.
 */
export function capLogFields<T extends CappableLogFields>(fields: T): T {
  const conditions = fields.matchConditions;
  let cappedConditions = conditions;
  if (conditions !== undefined) {
    const serialised = JSON.stringify(conditions) ?? "";
    if (new TextEncoder().encode(serialised).length > MAX_MATCH_CONDITIONS_BYTES) {
      cappedConditions = { truncated: true };
    }
  }

  return {
    ...fields,
    url: capBytes(fields.url, MAX_LOG_TEXT_BYTES),
    prompt: capBytes(fields.prompt, MAX_LOG_TEXT_BYTES),
    error: capOptional(fields.error, MAX_LOG_TEXT_BYTES),
    monitorName: capOptional(fields.monitorName, MAX_LOG_TEXT_BYTES),
    aiUnderstanding: capOptional(fields.aiUnderstanding, MAX_LOG_TEXT_BYTES),
    aiMatchSignal: capOptional(fields.aiMatchSignal, MAX_LOG_TEXT_BYTES),
    aiNoMatchSignal: capOptional(fields.aiNoMatchSignal, MAX_LOG_TEXT_BYTES),
    strategy: capOptional(fields.strategy, MAX_LOG_TEXT_BYTES),
    blockReason: capOptional(fields.blockReason, MAX_LOG_TEXT_BYTES),
    aiNotices: fields.aiNotices
      ?.slice(0, MAX_LOG_NOTICES)
      .map((n) => capBytes(n, MAX_LOG_NOTICE_BYTES)),
    rawResponse: capRawResponse(fields.rawResponse),
    matchConditions: cappedConditions,
  };
}
