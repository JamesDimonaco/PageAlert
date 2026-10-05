/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, components } from "./_generated/api";
import schema from "./schema";
import betterAuthSchema from "./betterAuth/schema";
import { SMS_ANNOUNCED_AT } from "./announcements";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

beforeEach(() => vi.stubEnv("SMS_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

async function signUp(t: ReturnType<typeof harness>, createdAt: number): Promise<string> {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: { name: "A Person", email: `${createdAt}@example.test`, emailVerified: true, createdAt, updatedAt: createdAt },
    },
  })) as { _id: string };
  return user._id;
}

const existingUser = (t: ReturnType<typeof harness>) => signUp(t, SMS_ANNOUNCED_AT - 1);

describe("whatsNew: who sees the SMS announcement", () => {
  it("shows to an account that predates the launch and has not seen it", async () => {
    const t = harness();
    const userId = await existingUser(t);
    expect(await t.withIdentity({ subject: userId }).query(api.announcements.whatsNew, {})).toBe(true);
  });

  it("hides from an account created at or after the launch, who get onboarding instead", async () => {
    const t = harness();
    const userId = await signUp(t, SMS_ANNOUNCED_AT);
    expect(await t.withIdentity({ subject: userId }).query(api.announcements.whatsNew, {})).toBe(false);
  });

  it("hides from someone who already has texts switched on", async () => {
    const t = harness();
    const userId = await existingUser(t);
    await t.run((ctx) =>
      ctx.db.insert("notificationSettings", { userId, channel: "sms", enabled: true, target: "+447911100000" })
    );
    expect(await t.withIdentity({ subject: userId }).query(api.announcements.whatsNew, {})).toBe(false);
  });

  it("still shows to someone with a disabled sms row", async () => {
    const t = harness();
    const userId = await existingUser(t);
    await t.run((ctx) =>
      ctx.db.insert("notificationSettings", { userId, channel: "sms", enabled: false, target: "+447911100000" })
    );
    expect(await t.withIdentity({ subject: userId }).query(api.announcements.whatsNew, {})).toBe(true);
  });

  it("hides while the SMS kill switch is off, since the settings card is hidden too", async () => {
    vi.stubEnv("SMS_ENABLED", "false");
    const t = harness();
    const userId = await existingUser(t);
    expect(await t.withIdentity({ subject: userId }).query(api.announcements.whatsNew, {})).toBe(false);
  });

  it("hides from a signed-out caller", async () => {
    const t = harness();
    expect(await t.query(api.announcements.whatsNew, {})).toBe(false);
  });

  it("stays hidden after dismiss when no activity row exists yet", async () => {
    const t = harness();
    const userId = await existingUser(t);
    const asUser = t.withIdentity({ subject: userId });
    await asUser.mutation(api.announcements.dismissWhatsNew, {});
    expect(await asUser.query(api.announcements.whatsNew, {})).toBe(false);
  });

  it("stays hidden after dismiss on top of an existing activity row, without adding a second", async () => {
    const t = harness();
    const userId = await existingUser(t);
    const asUser = t.withIdentity({ subject: userId });
    await asUser.mutation(api.account.touchLastSeen, {});
    expect(await asUser.query(api.announcements.whatsNew, {})).toBe(true);
    await asUser.mutation(api.announcements.dismissWhatsNew, {});
    const rows = await t.run((ctx) => ctx.db.query("userActivity").collect());
    expect(rows).toHaveLength(1);
    expect(await asUser.query(api.announcements.whatsNew, {})).toBe(false);
  });

  it("keeps the seen mark when touchLastSeen stamps an existing row", async () => {
    const t = harness();
    const userId = await existingUser(t);
    const asUser = t.withIdentity({ subject: userId });
    await asUser.mutation(api.announcements.dismissWhatsNew, {});
    await t.run(async (ctx) => {
      const row = await ctx.db.query("userActivity").first();
      await ctx.db.patch(row!._id, { lastSeenAt: 0 });
    });
    await asUser.mutation(api.account.touchLastSeen, {});
    expect(await asUser.query(api.announcements.whatsNew, {})).toBe(false);
  });
});

it("pins the launch cutoff", () => {
  expect(new Date(SMS_ANNOUNCED_AT).toISOString()).toBe("2026-10-05T00:00:00.000Z");
});
