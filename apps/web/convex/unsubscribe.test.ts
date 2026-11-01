/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "./unsubscribe";

const modules = import.meta.glob("./**/*.*s");

beforeEach(() => vi.stubEnv("UNSUBSCRIBE_SECRET", "test-secret"));
afterEach(() => vi.unstubAllEnvs());

describe("unsubscribe token", () => {
  it("verifies for the user it was signed for", async () => {
    const token = await signUnsubscribeToken("user-a");
    expect(await verifyUnsubscribeToken("user-a", token)).toBe(true);
  });

  it("rejects a token signed for a different user", async () => {
    const token = await signUnsubscribeToken("user-a");
    expect(await verifyUnsubscribeToken("user-b", token)).toBe(false);
  });

  it("rejects a tampered token", async () => {
    const token = await signUnsubscribeToken("user-a");
    const flipped = (token[0] === "0" ? "1" : "0") + token.slice(1);
    expect(await verifyUnsubscribeToken("user-a", flipped)).toBe(false);
  });

  it("rejects malformed tokens without throwing", async () => {
    for (const bad of ["", "zz", "abc", "0".repeat(64)]) {
      expect(await verifyUnsubscribeToken("user-a", bad)).toBe(false);
    }
  });

  it("rejects a token signed under another secret", async () => {
    const token = await signUnsubscribeToken("user-a");
    vi.stubEnv("UNSUBSCRIBE_SECRET", "rotated");
    expect(await verifyUnsubscribeToken("user-a", token)).toBe(false);
  });

  it("refuses to sign when the secret is unset, rather than signing with an empty key", async () => {
    vi.stubEnv("UNSUBSCRIBE_SECRET", "");
    await expect(signUnsubscribeToken("user-a")).rejects.toThrow(/UNSUBSCRIBE_SECRET/);
  });
});

const harness = () => convexTest(schema, modules);

describe("/unsubscribe route", () => {
  async function optedOut(t: ReturnType<typeof harness>, userId: string) {
    const rows = await t.run(async (ctx) =>
      ctx.db.query("emailOptOuts").withIndex("by_userId_and_category", (q) => q.eq("userId", userId)).collect()
    );
    return rows.map((r) => r.category).sort();
  }
  async function path(userId: string, token?: string, category = "updates") {
    return `/unsubscribe?u=${encodeURIComponent(userId)}&c=${category}&t=${token ?? (await signUnsubscribeToken(userId))}`;
  }

  it("POST with a valid token opts the user out", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(await path("user-a"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200);
    expect(await optedOut(t, "user-a")).toEqual(["updates"]);
  });

  // A mail client's one-click POST must not take away more than the email it came on.
  it("one-click POST on a tips link removes tips only", async () => {
    const t = harness();
    await t.fetch(await path("user-a", undefined, "tips"), { method: "POST", body: "List-Unsubscribe=One-Click" });
    expect(await optedOut(t, "user-a")).toEqual(["tips"]);
  });

  it("the page's all-email button removes every category", async () => {
    const t = harness();
    await t.fetch(`${await path("user-a", undefined, "tips")}&scope=all`, { method: "POST" });
    expect(await optedOut(t, "user-a")).toEqual(["tips", "updates"]);
  });

  // Links from before categories existed are still sitting in inboxes.
  it("a link with no category still unsubscribes from product updates", async () => {
    const t = harness();
    const token = await signUnsubscribeToken("user-a");
    await t.fetch(`/unsubscribe?u=user-a&t=${token}`, { method: "POST" });
    expect(await optedOut(t, "user-a")).toEqual(["updates"]);
  });

  it("an unknown category is refused", async () => {
    const t = harness();
    const res = await t.fetch(await path("user-a", undefined, "billing"), { method: "POST" });
    expect(res.status).toBe(400);
    expect(await optedOut(t, "user-a")).toEqual([]);
  });

  it("POST twice leaves one row", async () => {
    const t = convexTest(schema, modules);
    const url = await path("user-a");
    await t.fetch(url, { method: "POST" });
    await t.fetch(url, { method: "POST" });
    expect(await optedOut(t, "user-a")).toEqual(["updates"]);
  });

  it("POST with another user's token is refused and opts nobody out", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(await path("user-a", await signUnsubscribeToken("user-b")), { method: "POST" });
    expect(res.status).toBe(400);
    expect(await optedOut(t, "user-a")).toEqual([]);
    expect(await optedOut(t, "user-b")).toEqual([]);
  });

  it("GET shows a confirm page and does not opt out, so link scanners cannot unsubscribe people", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(await path("user-a"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("<form");
    expect(await optedOut(t, "user-a")).toEqual([]);
  });

  // The heading promises one category, so its button must not carry scope=all.
  it("GET on a link with a stray scope=all still gives a single-category Unsubscribe button", async () => {
    const t = harness();
    const html = await (await t.fetch(`${await path("user-a", undefined, "tips")}&scope=all`)).text();
    const actions = [...html.matchAll(/action="([^"]+)"/g)].map((m) => m[1]);
    expect(actions[0]).not.toContain("scope=all");
    expect(actions[1]).toContain("scope=all");
  });

  it("GET with a bad token is refused", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(await path("user-a", "00"));
    expect(res.status).toBe(400);
  });
});
