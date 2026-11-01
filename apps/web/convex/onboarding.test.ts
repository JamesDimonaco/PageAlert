/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.*s");

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("ONBOARDING_EMAILS_ENABLED", "true");
  vi.stubEnv("UNSUBSCRIBE_SECRET", "test-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// The unsubscribe page promises no more tips. The welcome email is one.
it("skips the welcome email for someone unsubscribed from tips, and sends the rest", async () => {
  const t = convexTest(schema, modules);
  const now = Date.now();
  await t.run(async (ctx) => {
    for (const userId of ["keep", "gone"]) {
      await ctx.db.insert("onboardingEmails", {
        userId,
        email: `${userId}@example.com`,
        step: "day0",
        scheduledFor: now - 1000,
        status: "pending",
      });
    }
    await ctx.db.insert("emailOptOuts", { userId: "gone", category: "tips", optedOutAt: now });
  });

  await t.action(internal.onboarding.processDueEmails, {});

  const rows = await t.run((ctx) => ctx.db.query("onboardingEmails").collect());
  expect(Object.fromEntries(rows.map((r) => [r.userId, r.status]))).toEqual({ keep: "sent", gone: "skipped" });
  const sentTo = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body).to);
  expect(sentTo).toEqual([["keep@example.com"]]);
});

// Day 1 says "you haven't set up a monitor yet", so it must not reach anyone who has.
it("sends day 1 only to people with no monitor, with an unsubscribe link and a reply-to", async () => {
  vi.stubEnv("ADMIN_EMAIL", "admin@example.com");
  const t = convexTest(schema, modules);
  const now = Date.now();
  await t.run(async (ctx) => {
    for (const userId of ["new", "started"]) {
      await ctx.db.insert("onboardingEmails", {
        userId,
        email: `${userId}@example.com`,
        step: "day1",
        scheduledFor: now - 1000,
        status: "pending",
      });
    }
    // The creation log, not the monitor: someone who made one and deleted it has still started.
    await ctx.db.insert("monitorCreations", { userId: "started", createdAt: now });
  });

  await t.action(internal.onboarding.processDueEmails, {});

  const rows = await t.run((ctx) => ctx.db.query("onboardingEmails").collect());
  expect(Object.fromEntries(rows.map((r) => [r.userId, r.status]))).toEqual({ new: "sent", started: "skipped" });
  const sent = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body));
  expect(sent).toHaveLength(1);
  expect(sent[0].to).toEqual(["new@example.com"]);
  expect(sent[0].reply_to).toBe("admin@example.com");
  expect(sent[0].headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  expect(sent[0].html).toContain("c=tips");
  expect(sent[0].text).toContain("Unsubscribe from tips");
});

// A signup kicks the processor while the hourly cron can be running too.
it("two processor runs at once send each email once", async () => {
  const t = convexTest(schema, modules);
  await t.run((ctx) =>
    ctx.db.insert("onboardingEmails", {
      userId: "u",
      email: "u@example.com",
      step: "day0",
      scheduledFor: Date.now() - 1000,
      status: "pending",
    })
  );
  await Promise.all([
    t.action(internal.onboarding.processDueEmails, {}),
    t.action(internal.onboarding.processDueEmails, {}),
  ]);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
