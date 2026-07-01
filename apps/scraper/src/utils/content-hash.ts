import { createHash } from "node:crypto";

/**
 * Stable fingerprint of page text for change detection.
 * Whitespace-collapsed and lowercased so trivial formatting shifts
 * don't register as content changes.
 */
export function hashContent(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256").update(normalized).digest("hex");
}
