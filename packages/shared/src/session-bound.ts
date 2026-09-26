/**
 * Query keys that only mean something inside the browser session that made
 * the link: CSRF and session tokens, and the signature on a presigned URL.
 * Our scraper arrives without that session, so the page refuses it however
 * many times we retry.
 *
 * Kept apart from url-identity's VOLATILE_PARAMS on purpose. That list answers
 * "is this still the same item?" and strips keys from every scraped link, so
 * adding `token`, `sid` or `signature` there would merge items that differ
 * only by them. This one answers "will this link keep working?" and only ever
 * produces a warning, so it can afford the false positives `sid` and `token`
 * bring.
 */
const SESSION_BOUND_KEYS = new Set([
  "csrftoken",
  "csrf",
  "_csrf",
  "token",
  "authenticity_token",
  "session",
  "sessionid",
  "sid",
  "jsessionid",
  "phpsessid",
  "auth",
  "signature",
  "x-amz-signature",
  "x-amz-credential",
  "expires",
]);

/**
 * The query keys in `url` that tie it to one browser session, as written in
 * the URL, each named once. Empty for anything that does not parse yet.
 */
export function sessionBoundParams(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const keys = new Set<string>();
  for (const key of parsed.searchParams.keys()) {
    if (SESSION_BOUND_KEYS.has(key.toLowerCase())) keys.add(key);
  }
  return [...keys];
}
