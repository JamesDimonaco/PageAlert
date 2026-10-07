/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { CHANGELOG, latestChangelogEntry } from "@prowl/shared";
import { api, components } from "./_generated/api";
import schema from "./schema";
import betterAuthSchema from "./betterAuth/schema";
import { SMS_LIMITS } from "./tiers";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

const latest = latestChangelogEntry();
const latestAt = Date.parse(`${latest.date}T00:00:00Z`);

async function signUp(t: ReturnType<typeof harness>, createdAt: number): Promise<string> {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: { name: "A Person", email: `${createdAt}@example.test`, emailVerified: true, createdAt, updatedAt: createdAt },
    },
  })) as { _id: string };
  return user._id;
}

const existingUser = (t: ReturnType<typeof harness>) => signUp(t, latestAt - 1);

describe("whatsNew.show: who gets the newest changelog entry as a popup", () => {
  it("shows to an account that predates it and has not dismissed it", async () => {
    const t = harness();
    const userId = await existingUser(t);
    expect(await t.withIdentity({ subject: userId }).query(api.whatsNew.show, {})).toEqual(latest);
  });

  it("hides from an account created on or after its day", async () => {
    const t = harness();
    const userId = await signUp(t, latestAt);
    expect(await t.withIdentity({ subject: userId }).query(api.whatsNew.show, {})).toBeNull();
  });

  it("shows again when the only dismissal on record is for an older entry", async () => {
    const t = harness();
    const userId = await existingUser(t);
    await t.run((ctx) =>
      ctx.db.insert("userActivity", { userId, lastSeenAt: 0, announcementsSeen: [CHANGELOG[1].id] })
    );
    expect(await t.withIdentity({ subject: userId }).query(api.whatsNew.show, {})).toEqual(latest);
  });

  it("hides from a signed-out caller", async () => {
    const t = harness();
    expect(await t.query(api.whatsNew.show, {})).toBeNull();
  });

  it("stays hidden after dismiss when no activity row exists yet", async () => {
    const t = harness();
    const userId = await existingUser(t);
    const asUser = t.withIdentity({ subject: userId });
    await asUser.mutation(api.whatsNew.dismiss, { id: latest.id });
    expect(await asUser.query(api.whatsNew.show, {})).toBeNull();
  });

  it("stays hidden after dismiss on top of an existing activity row, without adding a second", async () => {
    const t = harness();
    const userId = await existingUser(t);
    const asUser = t.withIdentity({ subject: userId });
    await asUser.mutation(api.account.touchLastSeen, {});
    await asUser.mutation(api.whatsNew.dismiss, { id: latest.id });
    const rows = await t.run((ctx) => ctx.db.query("userActivity").collect());
    expect(rows).toHaveLength(1);
    expect(await asUser.query(api.whatsNew.show, {})).toBeNull();
  });

  it("ignores an id that is not in the changelog", async () => {
    const t = harness();
    const userId = await existingUser(t);
    await t.withIdentity({ subject: userId }).mutation(api.whatsNew.dismiss, { id: "made-up" });
    const rows = await t.run((ctx) => ctx.db.query("userActivity").collect());
    expect(rows).toHaveLength(0);
  });

  it("keeps the seen mark when touchLastSeen stamps an existing row", async () => {
    const t = harness();
    const userId = await existingUser(t);
    const asUser = t.withIdentity({ subject: userId });
    await asUser.mutation(api.whatsNew.dismiss, { id: latest.id });
    await t.run(async (ctx) => {
      const row = await ctx.db.query("userActivity").first();
      await ctx.db.patch(row!._id, { lastSeenAt: 0 });
    });
    await asUser.mutation(api.account.touchLastSeen, {});
    expect(await asUser.query(api.whatsNew.show, {})).toBeNull();
  });
});

describe("changelog figures that come from server limits", () => {
  it("quotes the free SMS limits", () => {
    const sms = CHANGELOG.find((e) => e.id === "sms-alerts")!;
    expect(sms.body).toContain(`${SMS_LIMITS.free.month} texts a month, up to ${SMS_LIMITS.free.day} a day`);
  });

  // Keeps the id that the original texts popup stored, so nobody who dismissed it sees it twice.
  it("keeps the texts entry on its original id and day", () => {
    expect(CHANGELOG.find((e) => e.id === "sms-alerts")?.date).toBe("2026-10-06");
  });
});
