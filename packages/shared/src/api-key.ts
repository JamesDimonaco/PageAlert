/** Recognisable in a leaked log or to a secret scanner. */
export const API_KEY_PREFIX = "pa_live_";

const KEY_BYTES = 32;
const KEY_PATTERN = new RegExp(`^${API_KEY_PREFIX}[0-9a-f]{64}$`);

export function formatApiKey(random: Uint8Array): string {
  if (random.length !== KEY_BYTES) throw new Error(`An API key needs ${KEY_BYTES} random bytes`);
  return API_KEY_PREFIX + Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cheap reject before a database lookup. */
export function looksLikeApiKey(value: string): boolean {
  return KEY_PATTERN.test(value);
}

/** What we store. The plaintext is shown once and never kept. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function apiKeyHint(key: string): string {
  return key.slice(0, API_KEY_PREFIX.length + 4);
}
