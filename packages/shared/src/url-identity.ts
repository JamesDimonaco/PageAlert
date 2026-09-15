/**
 * Query parameters that change without the page changing.
 *
 * Amazon stamps a `qid` timestamp and a per-request `dib` token onto every
 * product link, so two scrapes of one unchanged listing page share not a
 * single URL between them. Identity is the URL, so without this every entry
 * reads as a new arrival on every check: the same product alerts hourly, and
 * a blacklisted one never stays hidden.
 */
const VOLATILE_PARAMS = [
  /^utm_/,
  /^pd_rd_/,
  /^pf_rd_/,
  /^_?(dib|dib_tag|qid|sr|sprefix|crid|psc|th|smid|sbo|content-id|keywords|encoding)$/,
  // Amazon's facet links carry a per-request `ds` token; `dc` rides along empty.
  /^(ds|dc|rnid)$/,
  /^(ref|ref_|tag|linkCode|linkId|creative|creativeASIN|ascsubtag|camp)$/,
  /^(fbclid|gclid|msclkid|igshid|mc_cid|mc_eid|spm|scm|_gl|si)$/,
  /^(session|sessionid|sid|jsessionid|phpsessid)$/i,
];

/** Amazon buries a session id in the path after a `/ref=` segment. */
const PATH_NOISE = /\/ref=[^/]*(\/.*)?$/i;

function isVolatile(name: string): boolean {
  return VOLATILE_PARAMS.some((re) => re.test(name));
}

/**
 * A URL reduced to what identifies the thing it points at.
 *
 * Falls back to the trimmed original whenever parsing fails, so a malformed
 * link keeps a stable identity of its own rather than collapsing into a
 * shared empty key.
 */
export function canonicalUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }

  parsed.hash = "";
  for (const name of [...parsed.searchParams.keys()]) {
    if (isVolatile(name)) parsed.searchParams.delete(name);
  }
  parsed.searchParams.sort();

  // Host is case-insensitive by spec and is lowercased; path and query are
  // not. Folding those too would merge two entries whose ids differ only in
  // case — a real risk wherever an id is a base64-ish token — and the second
  // one would then be suppressed as already seen.
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.replace(PATH_NOISE, "").replace(/\/+$/, "");
  const query = parsed.searchParams.toString();

  return `${host}${path}${query ? `?${query}` : ""}`;
}

/**
 * How a scored entry is matched back to the item shown on the monitor page.
 *
 * The two sides come from different scrapes — the items tab renders the AI's
 * extract, the verdicts come from routine checks — so a raw URL joins nothing
 * on any site that stamps its links per request.
 */
export function itemIdentity(item: {
  url?: unknown;
  title?: unknown;
  price?: unknown;
}): string {
  const url = item.url ? String(item.url).trim() : "";
  if (url) return canonicalUrl(url);
  return `${String(item.title ?? "")}-${String(item.price ?? "")}`;
}
