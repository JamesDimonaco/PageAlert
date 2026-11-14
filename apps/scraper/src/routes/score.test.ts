import { describe, expect, it, vi } from "vitest";

vi.mock("../services/extractor.js", () => ({
  scoreCandidates: vi.fn(async (candidates: unknown[]) => candidates.map((c) => ({ ...(c as object), matchScore: 90, matchReason: "" }))),
}));

const { scoreRoutes } = await import("./score.js");

const entry = (title: string, snippet = "In stock") => ({ title, url: null, price: 199, snippet });
const post = (body: unknown) =>
  scoreRoutes.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("score route", () => {
  // A listing monitor that asks for stock judges several new entries at once.
  // Refused, every entry falls back to unscored and alerts, sold out or not.
  it("reads stock for several listing entries", async () => {
    const res = await post({ prompt: "in stock", candidates: [entry("Kingston"), entry("Corsair")], readStock: true });
    expect(res.status).toBe(200);
  });

  // A product read sends the longer product excerpt, which only one entry may carry.
  it("takes a long product excerpt for one entry only", async () => {
    const long = "x".repeat(700);
    expect((await post({ prompt: "in stock", candidates: [entry("Kingston", long)], readStock: true })).status).toBe(200);
    expect((await post({ prompt: "in stock", candidates: [entry("Kingston", long), entry("Corsair")], readStock: true })).status).toBe(400);
  });
});
