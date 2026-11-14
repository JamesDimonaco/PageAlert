import { describe, expect, it, vi } from "vitest";

const soldOut = { title: "Kingston FURY 16GB", price: 199, url: "https://shop.test/ram", inStock: null };
const wanted = { title: "Corsair Vengeance 16GB", price: 179, url: "https://shop.test/corsair", inStock: true };

vi.mock("../services/scraper.js", () => ({
  FALLBACK_PROVIDER_ERROR: "Fallback provider",
  scrapeUrl: vi.fn(async () => ({ text: "page", scrapedAt: "2026-11-14T00:00:00.000Z", blocked: false })),
}));
vi.mock("../services/extractor.js", () => ({
  extractWithAI: vi.fn(async () => ({
    schema: { fields: {}, items: [soldOut, wanted], matchConditions: { inStockOnly: true } },
    matches: [soldOut, wanted],
  })),
  scoreCandidates: vi.fn(async (candidates: { title: string }[]) =>
    candidates.map((c) => ({
      ...c,
      matchScore: 90,
      matchReason: "",
      stock: { inStock: c.title !== soldOut.title, price: null, currency: null },
    }))
  ),
}));

const { extractRoutes } = await import("./extract.js");

describe("extract route", () => {
  // Every first scan, preview and full re-read comes through here, so the
  // judging has to happen here for all of them.
  it("returns only the matches the scorer passes, with the sold-out one marked in the items", async () => {
    const res = await extractRoutes.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://shop.test/ram-list", prompt: "16GB RAM in stock" }),
    });
    const body = (await res.json()) as { matches: { title: string }[]; schema: { items: { inStock: unknown }[] } };
    expect(res.status).toBe(200);
    expect(body.matches.map((m) => m.title)).toEqual([wanted.title]);
    expect(body.schema.items.map((i) => i.inStock)).toEqual([false, true]);
  });
});
