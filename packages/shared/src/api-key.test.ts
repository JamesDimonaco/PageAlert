import { describe, expect, it } from "vitest";
import { API_KEY_PREFIX, apiKeyHint, formatApiKey, hashApiKey, looksLikeApiKey } from "./api-key";

const ZERO_KEY = `pa_live_${"0".repeat(64)}`;

describe("key format", () => {
  // The prefix is what makes a key recognisable in a leaked log or a secret
  // scanner. Changing it strands every key already handed out.
  it("starts with pa_live_", () => {
    expect(API_KEY_PREFIX).toBe("pa_live_");
    expect(formatApiKey(new Uint8Array(32))).toBe(ZERO_KEY);
  });

  it("carries 32 random bytes as lowercase hex", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    const key = formatApiKey(bytes);
    expect(key).toMatch(/^pa_live_[0-9a-f]{64}$/);
    expect(key.slice(8, 12)).toBe("0007");
  });

  it("refuses anything but 32 bytes, so a short key can never be minted", () => {
    expect(() => formatApiKey(new Uint8Array(16))).toThrow();
  });
});

describe("looksLikeApiKey", () => {
  it("accepts a minted key", () => {
    expect(looksLikeApiKey(ZERO_KEY)).toBe(true);
  });

  it.each([
    ["no prefix", "0".repeat(64)],
    ["wrong prefix", `pa_test_${"0".repeat(64)}`],
    ["one char short", `pa_live_${"0".repeat(63)}`],
    ["one char long", `pa_live_${"0".repeat(65)}`],
    ["uppercase hex", `pa_live_${"A".repeat(64)}`],
    ["surrounding space", ` ${ZERO_KEY}`],
  ])("rejects %s", (_, value) => {
    expect(looksLikeApiKey(value)).toBe(false);
  });
});

describe("hashApiKey", () => {
  // Stored hashes are compared against this. If the algorithm or encoding
  // moves, every issued key silently stops working.
  it("is hex SHA-256 of the whole key, prefix included", async () => {
    expect(await hashApiKey(ZERO_KEY)).toBe(
      "01117cab200fee5a5a8ce1aca775893ee93397abb88807a2ee93268fbd58492b"
    );
  });
});

describe("apiKeyHint", () => {
  it("shows the prefix and four characters, enough to tell keys apart and no more", () => {
    expect(apiKeyHint(`pa_live_abcdef${"0".repeat(58)}`)).toBe("pa_live_abcd");
  });
});
