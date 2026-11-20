import { describe, expect, it } from "vitest";
import { resolvesToPrivate } from "./url-validation.js";

// Every request the browser makes is checked with this, not only the URL the
// monitor names: a public page can redirect to, or load from, an address
// inside our own network.
describe("resolvesToPrivate", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "192.168.0.10",
    "169.254.169.254",
    "[::1]",
    // IPv4 written inside IPv6. The old check read these as public.
    "[::ffff:10.0.0.1]",
    "[::ffff:7f00:1]",
    "localhost",
    "metadata.google.internal",
  ])("treats %s as internal", async (host) => {
    expect(await resolvesToPrivate(host)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.216.34", "[2606:4700:4700::1111]"])("treats %s as public", async (host) => {
    expect(await resolvesToPrivate(host)).toBe(false);
  });
});
