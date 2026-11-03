/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.*s");

async function seedProductMonitor(lastSeen?: Doc<"monitors">["lastSeen"]) {
  const t = convexTest(schema, modules);
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
      alertOn: { backInStock: true },
      lastSeen,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const read = (inStock: boolean | null) =>
    t.mutation(internal.scheduler.recordProductRead, {
      monitorId: id,
      productFingerprint: `hash-${String(inStock)}`,
      inStock,
      price: null,
      currency: null,
    });
  const alertsScheduled = async () =>
    (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter((job) =>
      job.name.includes("sendBackInStockAlert")
    ).length;
  return { t, id, read, alertsScheduled };
}

// A back-in-stock alert is only worth anything if it means the product just
// came back. Firing on every in-stock read would spam the user on each page
// change; missing the out-to-in step loses the one alert they asked for.
describe("back-in-stock fires only on out of stock to in stock", () => {
  test("in stock to in stock is silent", async () => {
    const { read, alertsScheduled } = await seedProductMonitor({ inStock: true });
    expect(await read(true)).toEqual({ backInStock: false });
    expect(await alertsScheduled()).toBe(0);
  });

  test("out of stock to in stock alerts, once", async () => {
    const { read, alertsScheduled } = await seedProductMonitor({ inStock: false });
    expect(await read(true)).toEqual({ backInStock: true });
    expect(await read(true)).toEqual({ backInStock: false });
    expect(await alertsScheduled()).toBe(1);
  });

  // Switching the option on for a product already in stock must not alert.
  test("no baseline never alerts", async () => {
    const { read, alertsScheduled } = await seedProductMonitor();
    expect(await read(true)).toEqual({ backInStock: false });
    expect(await alertsScheduled()).toBe(0);
  });

  // A read that cannot tell must neither alert nor wipe the last known state,
  // or a glitch between out and in would swallow the restock.
  test("an unknown stock value never alerts and keeps the last known one", async () => {
    const { t, id, read, alertsScheduled } = await seedProductMonitor({ inStock: false });
    expect(await read(null)).toEqual({ backInStock: false });
    expect((await t.run((ctx) => ctx.db.get(id)))?.lastSeen?.inStock).toBe(false);
    expect(await read(true)).toEqual({ backInStock: true });
    expect(await alertsScheduled()).toBe(1);
  });
});

// Mute is the user's "stop telling me about this" switch. A stock alert that
// ignored it would break that promise.
test("a muted monitor sends no back-in-stock alert", async () => {
  const { t, id } = await seedProductMonitor({ inStock: false });
  const notifications = () => t.run((ctx) => ctx.db.query("notifications").collect());

  await t.run((ctx) => ctx.db.patch(id, { muted: true }));
  await t.action(internal.scheduler.sendBackInStockAlert, { monitorId: id });
  expect(await notifications()).toHaveLength(0);

  await t.run((ctx) => ctx.db.patch(id, { muted: false }));
  await t.action(internal.scheduler.sendBackInStockAlert, { monitorId: id });
  expect((await notifications()).map((n) => n.message)).toEqual(["Sony WH-1000XM5 is back in stock on shop.test."]);
});
