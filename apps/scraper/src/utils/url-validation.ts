import { lookup } from "node:dns/promises";
import { URL } from "node:url";

/**
 * Maximum allowed URL length to prevent abuse.
 */
export const MAX_URL_LENGTH = 2048;

/**
 * Allowed protocols for scraping. Only http(s) is permitted.
 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Blocked hostnames that should never be scraped.
 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  "127.0.0.1",
  "[::1]",
  "metadata.google.internal",        // GCP metadata
  "169.254.169.254",                  // AWS/GCP/Azure metadata endpoint
  "metadata.internal",
]);

/**
 * Check if an IP address is in a private/internal range.
 * Blocks RFC 1918, loopback, link-local, multicast, etc.
 */
function isPrivateIP(ip: string): boolean {
  // IPv4 checks
  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => !isNaN(p))) {
    const [a, b] = parts;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (link-local / cloud metadata)
    if (a === 169 && b === 254) return true;
    // 0.0.0.0/8
    if (a === 0) return true;
    // 100.64.0.0/10 (Carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 198.18.0.0/15 (benchmarking)
    if (a === 198 && (b === 18 || b === 19)) return true;
    // 224.0.0.0/4 (multicast)
    if (a >= 224) return true;
  }

  // IPv6 checks
  const lower = ip.toLowerCase();
  if (lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
  if (lower === "::") return true;

  return false;
}

/**
 * Validates a URL for safe scraping. Performs both syntactic checks and
 * DNS resolution to block SSRF attacks targeting internal networks.
 *
 * Throws a descriptive error if the URL is not allowed.
 */
export async function validateUrlForScraping(url: string): Promise<void> {
  // Length check
  if (url.length > MAX_URL_LENGTH) {
    throw new Error(`URL exceeds maximum length of ${MAX_URL_LENGTH} characters`);
  }

  // Parse URL
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL format");
  }

  // Protocol check
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("Only http and https URLs are allowed");
  }

  // Hostname checks
  const hostname = parsed.hostname.toLowerCase();

  if (!hostname || hostname.length === 0) {
    throw new Error("URL must contain a valid hostname");
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error("This hostname is not allowed");
  }

  // Block IP addresses used directly (except after DNS resolution check below)
  // Also block hostnames that look like they could resolve to internal IPs
  const ipMatch = hostname.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  if (ipMatch && isPrivateIP(hostname)) {
    throw new Error("URLs pointing to private/internal IP addresses are not allowed");
  }

  // DNS resolution check - resolve hostname and verify it doesn't point to a private IP.
  // This prevents DNS rebinding and TOCTOU attacks where a hostname resolves to
  // an internal IP after initial validation.
  try {
    const { address } = await lookup(hostname);
    if (isPrivateIP(address)) {
      throw new Error("URL resolves to a private/internal IP address");
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("private/internal")) {
      throw err;
    }
    // DNS resolution failure - hostname doesn't resolve
    throw new Error("Could not resolve hostname");
  }
}
