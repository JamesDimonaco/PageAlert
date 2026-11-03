/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";
import type { Doc } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

async function seedProductMonitor(
  lastSeen?: Doc<"monitors">["lastSeen"],
  alertOn: Doc<"monitors">["alertOn"] = { backInStock: true }
) {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const id = await t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId: "user_1",
      name: "XM5",
      url: "https://shop.test/xm5",
      prompt: "tell me when it is in stock",
      status: "active",
      checkInterval: "1h",
      schema: { items: [{ title: "Sony WH-1000XM5" }] },
      matchCount: 0,
      alertOn,
      lastSeen,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const read = async (
    inStock: boolean | null,
    { price = null, currency = price === null ? null : "GBP", url = "https://shop.test/xm5" }: {
      price?: number | null;
      currency?: string | null;
      url?: string;
    } = {}
  ) => {
    const { alerts } = await t.mutation(internal.scheduler.recordProductRead, {
      monitorId: id,
      url,
      productFingerprint: `hash-${String(inStock)}-${String(price)}`,
      inStock,
      price,
      currency,
    });
    return alerts.map((a) => (a.kind === "stock" ? "stock" : a.reason));
  };
  const alertsScheduled = async () =>
    (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((job) =>
      job.name.includes("sendProductAlert")
    ).length;
  return { t, id, read, alertsScheduled };
}

// A back-in-stock alert is only worth anything if it means the product just
// came back. Firing on every in-stock read would spam the user on each page
// change; missing the out-to-in step loses the one alert they asked for.
describe("back-in-stock fires only on out of stock to in stock", () => {
  test("in stock to in stock is silent", async () => {
    const { read, alertsScheduled } = await seedProductMonitor({ inStock: true });
    expect(await read(true)).toEqual([]);
    expect(await alertsScheduled()).toBe(0);
  });

  test("out of stock to in stock alerts, once", async () => {
    const { read, alertsScheduled } = await seedProductMonitor({ inStock: false });
    expect(await read(true)).toEqual(["stock"]);
    expect(await read(true)).toEqual([]);
    expect(await alertsScheduled()).toBe(1);
  });

  // Switching the option on for a product already in stock must not alert.
  test("no baseline never alerts", async () => {
    const { read, alertsScheduled } = await seedProductMonitor();
    expect(await read(true)).toEqual([]);
    expect(await alertsScheduled()).toBe(0);
  });

  // A read that cannot tell must neither alert nor wipe the last known state,
  // or a glitch between out and in would swallow the restock.
  test("an unknown stock value never alerts and keeps the last known one", async () => {
    const { t, id, read, alertsScheduled } = await seedProductMonitor({ inStock: false });
    expect(await read(null)).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(id)))?.lastSeen?.inStock).toBe(false);
    expect(await read(true)).toEqual(["stock"]);
    expect(await alertsScheduled()).toBe(1);
  });
});

// The user picked "any drop" to hear about cheaper prices, and nothing else.
// A rise or a repeat of the same price would teach them to ignore the alert.
describe("any price drop", () => {
  const drop = { priceDrop: true };

  test("a lower price alerts", async () => {
    const { read } = await seedProductMonitor({ price: 29900, currency: "GBP" }, drop);
    expect(await read(true, { price: 27900 })).toEqual(["drop"]);
  });

  test("the same price is silent", async () => {
    const { read } = await seedProductMonitor({ price: 29900, currency: "GBP" }, drop);
    expect(await read(true, { price: 29900 })).toEqual([]);
  });

  test("a higher price is silent", async () => {
    const { read } = await seedProductMonitor({ price: 29900, currency: "GBP" }, drop);
    expect(await read(true, { price: 31900 })).toEqual([]);
  });

  // An unreadable price is not a price of zero; reading it as one would
  // announce a drop that never happened, then a rise, then a drop again.
  test("a missing price never alerts and keeps the last known one", async () => {
    const { read } = await seedProductMonitor({ price: 29900, currency: "GBP" }, drop);
    expect(await read(true)).toEqual([]);
    expect(await read(true, { price: 27900 })).toEqual(["drop"]);
  });

  // 2999 yen is not cheaper than 2999 pence; comparing across currencies
  // would alert on a site switching region, not on a price change.
  test("a price in another currency is not compared", async () => {
    const { read } = await seedProductMonitor({ price: 29900, currency: "GBP" }, drop);
    expect(await read(true, { price: 2999, currency: "JPY" })).toEqual([]);
  });
});

// "Below £250" means "tell me when I can buy it for £250". Once said, saying
// it again on every check while it stays cheap is noise.
describe("below a target price", () => {
  const below = { priceBelow: 25000 };

  test("crossing from above to at or below the target alerts", async () => {
    const { read } = await seedProductMonitor({ price: 29900, currency: "GBP" }, below);
    expect(await read(true, { price: 25000 })).toEqual(["below"]);
  });

  test("staying below the target does not alert again", async () => {
    const { read } = await seedProductMonitor({ price: 29900, currency: "GBP" }, below);
    expect(await read(true, { price: 24000 })).toEqual(["below"]);
    expect(await read(true, { price: 23000 })).toEqual([]);
  });

  test("a drop that stays above the target is silent", async () => {
    const { read } = await seedProductMonitor({ price: 29900, currency: "GBP" }, below);
    expect(await read(true, { price: 27900 })).toEqual([]);
  });
});

// Nothing is read while the option is off, so the stored "out of stock" goes
// stale. A restock during that time must not alert the moment the user turns
// the option back on.
test("turning the option back on takes a fresh baseline", async () => {
  const { t, id, read, alertsScheduled } = await seedProductMonitor({ inStock: false });
  const owner = t.withIdentity({ subject: "user_1" });

  await owner.mutation(api.monitors.update, { id, alertOn: { backInStock: false } });
  await owner.mutation(api.monitors.update, { id, alertOn: { backInStock: true } });
  expect(await read(true)).toEqual([]);
  expect(await alertsScheduled()).toBe(0);
});

// Setting a target under today's price is the normal case. It must wait for
// the price to cross, not fire on the next read against an old price.
test("setting a target takes a fresh price baseline", async () => {
  const { t, id, read } = await seedProductMonitor({ price: 29900, currency: "GBP" }, {});
  await t.withIdentity({ subject: "user_1" }).mutation(api.monitors.update, { id, alertOn: { priceBelow: 25000 } });
  expect(await read(true, { price: 24000 })).toEqual([]);
});

// A read that started before the URL was edited describes the old product.
// Stored, it would become the new product's baseline, or alert for it.
test("a read taken from a URL the monitor no longer has is dropped", async () => {
  const { t, id, read, alertsScheduled } = await seedProductMonitor({ inStock: false });
  await t.withIdentity({ subject: "user_1" }).mutation(api.monitors.update, { id, url: "https://shop.test/other" });

  expect(await read(true, { url: "https://shop.test/xm5" })).toEqual([]);
  const monitor = await t.run((ctx) => ctx.db.get(id));
  expect(monitor?.lastSeen).toBeUndefined();
  expect(monitor?.productFingerprint).toBeUndefined();
  // Makes the drift refresh due, which holds product reads until the new page is re-read.
  expect(monitor?.lastAiExtractAt).toBe(0);
  expect(await alertsScheduled()).toBe(0);
});

// Mute is the user's "stop telling me about this" switch. A stock alert that
// ignored it would break that promise.
test("a muted monitor sends no product alert", async () => {
  const { t, id } = await seedProductMonitor({ inStock: false });
  const notifications = () => t.run((ctx) => ctx.db.query("notifications").collect());

  await t.run((ctx) => ctx.db.patch(id, { muted: true }));
  await t.action(internal.scheduler.sendProductAlert, { monitorId: id, alert: { kind: "stock" } });
  expect(await notifications()).toHaveLength(0);

  await t.run((ctx) => ctx.db.patch(id, { muted: false }));
  await t.action(internal.scheduler.sendProductAlert, { monitorId: id, alert: { kind: "stock" } });
  expect((await notifications()).map((n) => n.message)).toEqual(["Sony WH-1000XM5 is back in stock on shop.test."]);
});

// The price alert must quote prices in the product's own currency, never "$".
test("a price alert names the old and new price in the product's currency", async () => {
  const { t, id } = await seedProductMonitor({}, { priceDrop: true });
  await t.action(internal.scheduler.sendProductAlert, {
    monitorId: id,
    alert: { kind: "price", reason: "drop", oldPrice: 29900, newPrice: 27900, currency: "GBP" },
  });
  const [notification] = await t.run((ctx) => ctx.db.query("notifications").collect());
  expect(notification?.message).toBe("Sony WH-1000XM5 is now £279.00 on shop.test, down from £299.00.");
});
