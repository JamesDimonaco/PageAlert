import { describe, expect, it, vi } from "vitest";
import type { ExtractionSchema, ExtractedItem } from "@prowl/shared";
import { judgeMatches, type Scorer } from "./judge-matches.js";

const ram: ExtractedItem = { title: "Kingston FURY 16GB", price: 199, url: "https://shop.test/ram", inStock: true };
const cooler: ExtractedItem = { title: "Noctua NH-L9a-AM5", price: 89, url: "https://shop.test/cooler", inStock: null };

function schema(items: ExtractedItem[], inStockOnly = false): ExtractionSchema {
  return { fields: {}, items, matchConditions: inStockOnly ? { inStockOnly: true } : {} };
}

/** A scorer that gives each title the score listed, and reads stock when asked. */
function scorer(scores: Record<string, number>, soldOut: string[] = []): Scorer {
  return vi.fn<Scorer>(async (candidates, readStock) =>
    candidates.map((c) => ({
      ...c,
      matchScore: scores[c.title] ?? null,
      matchReason: `reason for ${c.title}`,
      ...(readStock ? { stock: { inStock: !soldOut.includes(c.title), price: null, currency: null } } : {}),
    }))
  );
}

describe("judgeMatches", () => {
  // Prod, 12/11/2026: a first scan matched a sold-out RAM kit and a sold-out
  // cooler. Full reads were never scored, so nothing caught either.
  it("keeps matches the scorer passes, drops the rest, and says why", async () => {
    const result = await judgeMatches(schema([ram, cooler]), [ram, cooler], scorer({ [ram.title as string]: 60, [cooler.title as string]: 59 }));
    expect(result.matches).toEqual([{ ...ram, matchScore: 60, matchReason: `reason for ${ram.title}` }]);
  });

  // Marked sold out in the items, the entry joins the restock queue the
  // scheduler builds from them. Only dropped, it would never be read again.
  it("drops a match read as sold out when the prompt asks for stock, and marks it sold out in the items", async () => {
    const page = schema([ram, cooler], true);
    const result = await judgeMatches(page, [ram, cooler], scorer({ [ram.title as string]: 95, [cooler.title as string]: 95 }, [cooler.title as string]));
    expect(result.matches.map((m) => m.title)).toEqual([ram.title]);
    expect(result.schema.items).toEqual([ram, { ...cooler, inStock: false }]);
  });

  it("asks for stock only when the prompt does", async () => {
    const score = scorer({});
    await judgeMatches(schema([ram]), [ram], score);
    expect(score).toHaveBeenCalledWith(expect.any(Array), false);
    await judgeMatches(schema([ram], true), [ram], score);
    expect(score).toHaveBeenLastCalledWith(expect.any(Array), true);
  });

  // The scorer's own limit is 25 entries a call.
  it("judges more than 25 matches in calls of 25", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `Guitar ${i}`, url: `https://shop.test/${i}` }));
    const score = scorer(Object.fromEntries(many.map((m, i) => [m.title, i < 28 ? 80 : 10])));
    const result = await judgeMatches(schema(many), many, score);
    expect(vi.mocked(score).mock.calls.map(([candidates]) => candidates.length)).toEqual([25, 5]);
    expect(result.matches).toHaveLength(28);
  });

  // One rate-limited batch must not throw away the verdicts the others got.
  it("keeps a failed batch's matches unjudged and applies the rest", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `Guitar ${i}`, url: `https://shop.test/${i}` }));
    let call = 0;
    const score: Scorer = async (candidates) => {
      if (call++ === 1) throw new Error("429");
      return candidates.map((c) => ({ ...c, matchScore: 10, matchReason: "" }));
    };
    const result = await judgeMatches(schema(many), many, score);
    expect(result.matches.map((m) => m.title)).toEqual(many.slice(25).map((m) => m.title));
  });

  // Same rule as a quick check: a scoring outage must not silence a monitor.
  it("keeps every match when scoring fails", async () => {
    const page = schema([ram, cooler]);
    const result = await judgeMatches(page, [ram, cooler], vi.fn(async () => Promise.reject(new Error("529"))));
    expect(result).toEqual({ schema: page, matches: [ram, cooler] });
  });

  it("calls nothing when there is nothing to judge", async () => {
    const score = scorer({});
    expect((await judgeMatches(schema([ram]), [], score)).matches).toEqual([]);
    expect(score).not.toHaveBeenCalled();
  });

  // The scorer caps each entry's text at 600 characters.
  it("sends each match's other fields as its text, within the scorer's cap", async () => {
    const score = scorer({});
    await judgeMatches(schema([]), [{ ...ram, description: "x".repeat(1000) }], score);
    const [[candidate]] = vi.mocked(score).mock.calls[0]!;
    expect(candidate).toMatchObject({ title: ram.title, url: ram.url, price: 199 });
    expect(candidate!.snippet).toContain("inStock: true");
    expect(candidate!.snippet.length).toBeLessThanOrEqual(600);
  });
});
