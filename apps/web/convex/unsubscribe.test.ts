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

describe("/unsubscribe route", () => {
  async function optedOut(t: ReturnType<typeof convexTest>, userId: string) {
    return t.run(async (ctx) =>
      ctx.db.query("productUpdateOptOuts").withIndex("by_userId", (q) => q.eq("userId", userId)).collect()
    );
  }
  async function path(userId: string, token?: string) {
    return `/unsubscribe?u=${encodeURIComponent(userId)}&t=${token ?? (await signUnsubscribeToken(userId))}`;
  }

  it("POST with a valid token opts the user out", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(await path("user-a"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    });
    expect(res.status).toBe(200);
    expect(await optedOut(t, "user-a")).toHaveLength(1);
  });

  it("POST twice leaves one row", async () => {
    const t = convexTest(schema, modules);
    const url = await path("user-a");
    await t.fetch(url, { method: "POST" });
    await t.fetch(url, { method: "POST" });
    expect(await optedOut(t, "user-a")).toHaveLength(1);
  });

  it("POST with another user's token is refused and opts nobody out", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(await path("user-a", await signUnsubscribeToken("user-b")), { method: "POST" });
    expect(res.status).toBe(400);
    expect(await optedOut(t, "user-a")).toHaveLength(0);
    expect(await optedOut(t, "user-b")).toHaveLength(0);
  });

  it("GET shows a confirm page and does not opt out, so link scanners cannot unsubscribe people", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(await path("user-a"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(await res.text()).toContain("<form");
    expect(await optedOut(t, "user-a")).toHaveLength(0);
  });

  it("GET with a bad token is refused", async () => {
    const t = convexTest(schema, modules);
    const res = await t.fetch(await path("user-a", "00"));
    expect(res.status).toBe(400);
  });
});
