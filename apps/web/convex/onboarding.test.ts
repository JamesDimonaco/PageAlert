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
