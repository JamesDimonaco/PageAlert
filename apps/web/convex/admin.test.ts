/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import betterAuthSchema from "./betterAuth/schema";
import { api, components, internal } from "./_generated/api";
import { authComponent } from "./betterAuth/auth";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}
type T = ReturnType<typeof harness>;

async function seedUser(t: T, email: string): Promise<string> {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: { name: "A Person", email, emailVerified: true, createdAt: NOW, updatedAt: NOW },
    },
  })) as { _id: string };
  return user._id;
}

async function seedSession(t: T, userId: string, updatedAt: number, impersonatedBy?: string) {
  await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId,
        token: `tok_${userId}_${updatedAt}`,
        expiresAt: updatedAt + DAY,
        createdAt: updatedAt,
        updatedAt,
        ...(impersonatedBy ? { impersonatedBy } : {}),
      },
    },
  });
}

async function seedMonitor(t: T, userId: string, name: string) {
  return await t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId,
      name,
      url: "https://shop.test/laptops",
      prompt: "MacBook under £1000",
      status: "active",
      checkInterval: "1h",
      matchCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }),
  );
}

function signInAs(email: string) {
  vi.spyOn(authComponent, "safeGetAuthUser").mockResolvedValue({ email } as never);
}

beforeEach(() => {
  vi.stubEnv("SUPER_ADMIN_EMAILS", "admin@example.com");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("admin.userDetail", () => {
  it("refuses a caller who is not on the admin allow-list", async () => {
    const t = harness();
    const target = await seedUser(t, "target@example.com");
    signInAs("someone@example.com");

    await expect(t.query(api.admin.userDetail, { userId: target })).rejects.toThrow(/Not authorised/);
  });

  it("returns the user's own monitors and notifications, never another user's", async () => {
    const t = harness();
    const target = await seedUser(t, "target@example.com");
    const other = await seedUser(t, "other@example.com");
    const mine = await seedMonitor(t, target, "Mine");
    const theirs = await seedMonitor(t, other, "Theirs");
    await t.run(async (ctx) => {
      await ctx.db.insert("notifications", { userId: target, monitorId: mine, channel: "email", title: "Mine hit", message: "", sentAt: NOW, read: false });
      await ctx.db.insert("notifications", { userId: other, monitorId: theirs, channel: "email", title: "Theirs hit", message: "", sentAt: NOW, read: false });
    });
    signInAs("admin@example.com");

    const detail = await t.query(api.admin.userDetail, { userId: target });

    expect(detail.user?.email).toBe("target@example.com");
    expect(detail.monitors.map((m) => m.name)).toEqual(["Mine"]);
    expect(detail.notifications.map((n) => n.title)).toEqual(["Mine hit"]);
  });
});

describe("admin.listUsers", () => {
  // An admin viewing the account as the user must not make it look used: the
  // inactivity reaper reads the same last-active figure.
  it("ignores impersonation sessions when working out last active", async () => {
    const t = harness();
    const adminId = await seedUser(t, "admin@example.com");
    const target = await seedUser(t, "target@example.com");
    await seedSession(t, target, NOW - 30 * DAY);
    await seedSession(t, target, NOW, adminId);
    signInAs("admin@example.com");

    const users = await t.query(api.admin.listUsers, {});

    expect(users.find((u) => u.userId === target)?.lastActiveAt).toBe(NOW - 30 * DAY);
  });
});

// Thank-you grants for interviewees are run from the CLI, which has no admin
// session, so they go by email. A paying customer must never be overwritten.
describe("grantTrialByEmail", () => {
  it("gives a free user 30 days of Pro and leaves a paying user alone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = harness();
    const free = await seedUser(t, "free@example.com");
    const paying = await seedUser(t, "paying@example.com");
    await t.run((ctx) =>
      ctx.db.insert("userTiers", { userId: paying, tier: "max", polarSubscriptionId: "sub_1", updatedAt: NOW })
    );

    const result = await t.mutation(internal.admin.grantTrialByEmail, {
      emails: ["Free@Example.com", "paying@example.com", "nobody@example.com"],
      tier: "pro",
      days: 30,
    });

    expect(result).toEqual({ granted: 1, skippedPaying: 1, notFound: ["nobody@example.com"] });
    const tiers = await t.run((ctx) => ctx.db.query("userTiers").collect());
    // grantSource "admin" is what lets a later subscription count as a converted sale.
    expect(tiers.find((r) => r.userId === free)).toMatchObject({ tier: "pro", grantUntil: NOW + 30 * DAY, grantSource: "admin" });
    expect(tiers.find((r) => r.userId === paying)).toMatchObject({ tier: "max" });
    expect(tiers.find((r) => r.userId === paying)?.grantUntil).toBeUndefined();
    vi.useRealTimers();
  });

  it("grants a person listed twice only once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = harness();
    const id = await seedUser(t, "jo@example.com");
    const result = await t.mutation(internal.admin.grantTrialByEmail, { emails: ["Jo@example.com", "jo@example.com"], tier: "pro", days: 30 });
    expect(result.granted).toBe(1);
    const row = await t.run((ctx) => ctx.db.query("userTiers").withIndex("by_userId", (q) => q.eq("userId", id)).unique());
    expect(row?.grantUntil).toBe(NOW + 30 * DAY);
    vi.useRealTimers();
  });
});
