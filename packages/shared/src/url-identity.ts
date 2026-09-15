/**
 * Query parameters that change without the page changing.
 *
 * Split by blast radius. The general list holds names that are tracking
 * everywhere; the Amazon list holds names Amazon uses as request noise but
 * that carry real meaning elsewhere — `tag` is an affiliate code on Amazon
 * and a category filter on half the web, and stripping it globally would give
 * `?tag=sale` and `?tag=clearance` one identity.
 */
const VOLATILE_PARAMS = [
  /^utm_/,
  /^pd_rd_/,
  /^pf_rd_/,
  /^(fbclid|gclid|msclkid|igshid|mc_cid|mc_eid|_gl|spm|scm)$/,
  /^(ascsubtag|linkCode|linkId|creative|creativeASIN)$/,
  /^(session|sessionid|jsessionid|phpsessid)$/i,
];

const AMAZON_VOLATILE_PARAMS = [
  /^_?(dib|dib_tag|qid|sr|sprefix|crid|psc|th|smid|sbo|content-id|keywords|encoding)$/,
  // Sidebar facet links carry a `ds` token regenerated per request; `dc` rides along empty.
  /^(ds|dc|rnid)$/,
  /^(ref|ref_|tag)$/,
];

/** Amazon hangs a `ref=` marker and a session id off the end of the path. */
const REF_SEGMENT = /^ref=/i;
const SESSION_SEGMENT = /^\d{3}-\d{7}-\d{7}$/;

function isAmazon(host: string): boolean {
  return /(^|\.)amazon\.[a-z.]+$/i.test(host);
}

/**
 * A URL reduced to what identifies the thing it points at.
 *
 * Anything that is not an http(s) URL comes back untouched, so a key built
 * from a title rather than a link keeps its own identity. `new URL` would
 * otherwise read "Sony: WH-1000XM5" as the scheme `sony:` and hand every
 * brand the same key.
 */
export function canonicalUrl(raw: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "";

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return trimmed;

  // Host is case-insensitive by spec and folds; path and query do not. Folding
  // those would merge entries whose ids differ only in case — a real shape
  // wherever an id is a base64-ish token — and suppress the second as seen.
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const volatile = isAmazon(host)
    ? [...VOLATILE_PARAMS, ...AMAZON_VOLATILE_PARAMS]
    : VOLATILE_PARAMS;

  parsed.hash = "";
  for (const name of [...parsed.searchParams.keys()]) {
    if (volatile.some((re) => re.test(name))) parsed.searchParams.delete(name);
  }
  parsed.searchParams.sort();

  // Drop the noise segments themselves, not the rest of the path with them: a
  // site with `ref=` mid-path would otherwise lose the part that identifies
  // the listing.
  const path = parsed.pathname
    .split("/")
    .filter((segment) => !REF_SEGMENT.test(segment) && !SESSION_SEGMENT.test(segment))
    .join("/")
    .replace(/\/+$/, "");
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
