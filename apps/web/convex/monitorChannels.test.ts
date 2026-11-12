/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, components } from "./_generated/api";
import schema from "./schema";
import betterAuthSchema from "./betterAuth/schema";
import type { Doc, Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}
type T = ReturnType<typeof harness>;

async function signUp(t: T, email: string) {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: { name: "A Person", email, emailVerified: true, createdAt: 0, updatedAt: 0 },
    },
  })) as { _id: string };
  return { as: t.withIdentity({ subject: user._id, email }), userId: user._id };
}

type Channels = Doc<"monitors">["notificationChannels"];

function addMonitor(t: T, userId: string, name: string, notificationChannels: Channels, groupId?: Id<"monitorGroups">) {
  return t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId,
      name,
      url: `https://shop.test/${name}`,
      prompt: "anything",
      status: "active",
      checkInterval: "1h",
      notificationChannels,
      groupId,
      matchCount: 0,
      createdAt: 0,
      updatedAt: 0,
    })
  );
}

function addProduct(t: T, userId: string, notificationChannels: Channels) {
  return t.run((ctx) =>
    ctx.db.insert("monitorGroups", {
      userId,
      name: "Headphones",
      region: "GB",
      alertOn: { backInStock: true },
      notificationChannels,
      checkInterval: "1h",
      listings: [],
      createdAt: 0,
      updatedAt: 0,
    })
  );
}

const channelsOf = (t: T, id: Id<"monitors"> | Id<"monitorGroups">) =>
  t.run(async (ctx) => (await ctx.db.get(id))?.notificationChannels);

describe("connecting a channel", () => {
  // The point of the change: one connect reaches every monitor, so nobody has
  // to catch a toast or tick it on each one.
  it("turns Telegram on for every monitor and product, and undo takes back exactly that", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    const plain = await addMonitor(t, userId, "plain", ["email"]);
    const unset = await addMonitor(t, userId, "unset", undefined);
    const already = await addMonitor(t, userId, "already", ["telegram"]);
    const product = await addProduct(t, userId, ["email"]);
    const listing = await addMonitor(t, userId, "listing", ["email"], product);

    const rollout = await as.mutation(api.notificationSettings.upsert, { channel: "telegram", enabled: true, target: "12345" });

    expect(await channelsOf(t, plain)).toEqual(["email", "telegram"]);
    // Unset already means every channel.
    expect((await channelsOf(t, unset)) ?? undefined).toBeUndefined();
    expect(await channelsOf(t, already)).toEqual(["telegram"]);
    expect(await channelsOf(t, product)).toEqual(["email", "telegram"]);
    expect(await channelsOf(t, listing)).toEqual(["email", "telegram"]);
    expect(new Set(rollout.monitorIds)).toEqual(new Set([plain, listing]));
    expect(rollout.groupIds).toEqual([product]);

    await as.mutation(api.monitorChannels.undo, { channel: "telegram", ...rollout });
    expect(await channelsOf(t, plain)).toEqual(["email"]);
    expect(await channelsOf(t, already)).toEqual(["telegram"]);
    expect(await channelsOf(t, product)).toEqual(["email"]);
    expect(await channelsOf(t, listing)).toEqual(["email"]);
  });

  // Someone who turned Telegram off on a monitor and then fixes a typo in their
  // chat ID shouldn't find it switched back on.
  it("leaves monitors alone when an already-connected channel is edited", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    await as.mutation(api.notificationSettings.upsert, { channel: "telegram", enabled: true, target: "12345" });
    const off = await addMonitor(t, userId, "off", ["email"]);

    const rollout = await as.mutation(api.notificationSettings.upsert, { channel: "telegram", enabled: true, target: "67890" });

    expect(rollout).toEqual({ monitorIds: [], groupIds: [] });
    expect(await channelsOf(t, off)).toEqual(["email"]);
  });

  it("turns push on everywhere for the first device only", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    const m = await addMonitor(t, userId, "m", ["email"]);
    const device = (n: number) => ({ endpoint: `https://push.test/${n}`, p256dh: "k", auth: "a" });

    const first = await as.mutation(api.pushSubscriptions.subscribe, device(1));
    expect(first.monitorIds).toEqual([m]);
    expect(await channelsOf(t, m)).toEqual(["email", "push"]);

    await t.run((ctx) => ctx.db.patch(m, { notificationChannels: ["email"] }));
    const second = await as.mutation(api.pushSubscriptions.subscribe, device(2));
    expect(second.monitorIds).toEqual([]);
    expect(await channelsOf(t, m)).toEqual(["email"]);
  });

  it("refuses a new Discord connection while Discord is coming soon", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    await expect(
      as.mutation(api.notificationSettings.upsert, {
        channel: "discord",
        enabled: true,
        target: "https://discord.com/api/webhooks/1/x",
      })
    ).rejects.toThrow("coming soon");
  });
});

describe("turning a channel on from a monitor or the settings page", () => {
  // A product's listings share one list, so turning it on from one listing's
  // page turns it on for the product.
  it("turns a channel on for a listing's whole product", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    const product = await addProduct(t, userId, ["email"]);
    const a = await addMonitor(t, userId, "a", ["email"], product);
    const b = await addMonitor(t, userId, "b", ["email"], product);
    const other = await addMonitor(t, userId, "other", ["email"]);

    await as.mutation(api.monitorChannels.turnOn, { channel: "telegram", monitorId: a });

    expect(await channelsOf(t, a)).toEqual(["email", "telegram"]);
    expect(await channelsOf(t, b)).toEqual(["email", "telegram"]);
    expect(await channelsOf(t, product)).toEqual(["email", "telegram"]);
    expect(await channelsOf(t, other)).toEqual(["email"]);
  });

  it("reports which monitors and products are missing each channel, counting a product once", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    const product = await addProduct(t, userId, ["email", "telegram"]);
    await addMonitor(t, userId, "listing", ["email"], product);
    const solo = await addMonitor(t, userId, "solo", ["email", "telegram", "push"]);

    const units = await as.query(api.monitorChannels.coverage, {});

    expect(units).toHaveLength(2);
    expect(units.find((u) => u.id === product)).toMatchObject({ kind: "product", missing: ["push", "telegram", "discord"] });
    expect(units.find((u) => u.id === solo)).toMatchObject({ kind: "monitor", missing: ["discord"] });
  });

  it("changes nobody else's monitors", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { userId: otherId } = await signUp(t, "b@example.test");
    const theirs = await addMonitor(t, otherId, "theirs", ["email"]);
    const theirProduct = await addProduct(t, otherId, ["email"]);

    await expect(as.mutation(api.monitorChannels.turnOn, { channel: "telegram", monitorId: theirs })).rejects.toThrow();
    await expect(as.mutation(api.monitorChannels.turnOn, { channel: "telegram", groupId: theirProduct })).rejects.toThrow();
    await as.mutation(api.monitorChannels.undo, { channel: "email", monitorIds: [theirs], groupIds: [theirProduct] });
    await as.mutation(api.monitorChannels.turnOn, { channel: "telegram" });

    expect(await channelsOf(t, theirs)).toEqual(["email"]);
    expect(await channelsOf(t, theirProduct)).toEqual(["email"]);
  });

  it("never undoes a monitor down to no channels", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    const only = await addMonitor(t, userId, "only", ["telegram"]);

    await as.mutation(api.monitorChannels.undo, { channel: "telegram", monitorIds: [only], groupIds: [] });

    expect(await channelsOf(t, only)).toEqual(["telegram"]);
  });
});
