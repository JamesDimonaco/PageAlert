/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
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

  // A misread (a monthly payment, an accessory's price) would announce a
  // sale that is not there. A fall of more than half waits for a second read.
  test("a single wild drop is silent and does not replace the price", async () => {
    const { t, id, read } = await seedProductMonitor({ price: 29900, currency: "GBP" }, drop);
    expect(await read(true, { price: 2500 })).toEqual([]);
    expect(await read(true, { price: 29900 })).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(id)))?.lastSeen).toEqual({ inStock: true, price: 29900, currency: "GBP" });
  });

  test("a big drop seen twice alerts once", async () => {
    const { read } = await seedProductMonitor({ price: 29900, currency: "GBP" }, drop);
    expect(await read(true, { price: 9900 })).toEqual([]);
    expect(await read(true, { price: 9900 })).toEqual(["drop"]);
    expect(await read(true, { price: 9900 })).toEqual([]);
  });
});

// "Below £250" means "tell me when I can buy it for £250". Once said, saying
// it again on every check while it stays cheap is noise.
describe("below a target price", () => {
  const below = { priceBelow: { amount: 25000, currency: "GBP" } };

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

  // A user setting a target the product already meets wants to hear now,
  // not after the price has gone up and come back down.
  test("a target already met on the first read alerts once", async () => {
    const { read } = await seedProductMonitor({}, below);
    expect(await read(true, { price: 24000 })).toEqual(["below"]);
    expect(await read(true, { price: 23000 })).toEqual([]);
  });

  // 24,000 yen is not below £250. Comparing across currencies would alert
  // on numbers that mean different money.
  test("a price in another currency is never compared with the target", async () => {
    const { read } = await seedProductMonitor({}, below);
    expect(await read(true, { price: 24000, currency: "JPY" })).toEqual([]);
  });

  // A page that shows another currency on one read must not reset the
  // baseline, or the next normal read looks like a first read and repeats an
  // alert the user already had.
  test("a read in another currency does not reset the price, so the next read does not alert again", async () => {
    const { t, id, read } = await seedProductMonitor({}, { priceBelow: { amount: 10000, currency: "USD" } });
    expect(await read(true, { price: 9000, currency: "USD" })).toEqual(["below"]);
    expect(await read(true, { price: 12000, currency: "CAD" })).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(id)))?.lastSeen).toMatchObject({ price: 9000, currency: "USD" });
    expect(await read(true, { price: 9000, currency: "USD" })).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(id)))?.lastSeen).toEqual({ inStock: true, price: 9000, currency: "USD" });
  });
});

// A site that really moves to another currency would otherwise keep the old
// price forever, and price alerts would never fire again.
test("two reads in a new currency make it the baseline, with no alert for the switch", async () => {
  const { t, id, read } = await seedProductMonitor({ price: 29900, currency: "GBP" }, { priceDrop: true });
  expect(await read(true, { price: 35000, currency: "USD" })).toEqual([]);
  expect(await read(true, { price: 35000, currency: "USD" })).toEqual([]);
  expect((await t.run((ctx) => ctx.db.get(id)))?.lastSeen).toEqual({ inStock: true, price: 35000, currency: "USD" });
  expect(await read(true, { price: 34000, currency: "USD" })).toEqual(["drop"]);
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

// A target set under today's price waits for the price to cross it.
test("a target set under today's price waits for a crossing", async () => {
  const { t, id, read } = await seedProductMonitor({ price: 29900, currency: "GBP" }, {});
  await t.withIdentity({ subject: "user_1" }).mutation(api.monitors.update, {
    id,
    alertOn: { priceBelow: { amount: 25000, currency: "GBP" } },
  });
  expect(await read(true, { price: 27900 })).toEqual([]);
  expect(await read(true, { price: 24000 })).toEqual(["below"]);
});

// Each option resets only its own baseline. Editing the price choice must
// not lose a known "out of stock", or the restock it was waiting for would
// arrive as a silent baseline. The same goes the other way for a known price.
test("a new price choice keeps the stock history", async () => {
  const { t, id, read } = await seedProductMonitor({ inStock: false, price: 29900, currency: "GBP" });
  await t.withIdentity({ subject: "user_1" }).mutation(api.monitors.update, {
    id,
    alertOn: { backInStock: true, priceDrop: true },
  });
  const monitor = await t.run((ctx) => ctx.db.get(id));
  expect(monitor?.lastSeen).toEqual({ inStock: false });
  expect(monitor?.productFingerprint).toBeUndefined();
  expect(await read(true, { price: 27900 })).toEqual(["stock"]);
});

test("turning stock alerts on keeps the price history", async () => {
  const { t, id, read } = await seedProductMonitor({ inStock: true, price: 29900, currency: "GBP" }, { priceDrop: true });
  await t.withIdentity({ subject: "user_1" }).mutation(api.monitors.update, {
    id,
    alertOn: { backInStock: true, priceDrop: true },
  });
  expect((await t.run((ctx) => ctx.db.get(id)))?.lastSeen).toEqual({ price: 29900, currency: "GBP" });
  expect(await read(true, { price: 27900 })).toEqual(["drop"]);
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Stock = { inStock: boolean | null; price: number | null; currency: string | null };

/**
 * A product monitor on a page that never changes, whose product reads return
 * `reads` in turn (the last one repeats). Returns how many reads were paid for.
 */
async function onUnchangedPage(reads: Stock[]) {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  let scoreCalls = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/api/quick-check")) {
      return Response.json({
        accessible: true,
        contentHash: "page-2",
        candidates: [],
        totalEntries: 1,
        product: { excerpt: "Sony WH-1000XM5 £99.00 In stock", hash: "product-2", matched: true },
      });
    }
    if (url.endsWith("/api/score")) {
      const stock = reads[Math.min(scoreCalls, reads.length - 1)];
      scoreCalls++;
      return Response.json({
        scored: [{ title: "Sony WH-1000XM5", url: null, price: null, snippet: "", matchScore: 90, matchReason: "", stock }],
      });
    }
    return new Response("not mocked", { status: 500 });
  });

  const seeded = await seedProductMonitor({ price: 29900, currency: "GBP" }, { priceDrop: true });
  const { t, id } = seeded;
  await t.run((ctx) =>
    ctx.db.patch(id, { lastAiExtractAt: Date.now(), checkCount: 5, contentFingerprint: "page-1", productFingerprint: "product-1" })
  );
  const check = async () => {
    await t.run((ctx) => ctx.db.patch(id, { nextCheckAt: 0 }));
    await t.action(internal.scheduler.runScheduledChecks, {});
  };
  return { ...seeded, check, scoreCalls: () => scoreCalls };
}

// The second read that confirms a big drop has to happen even when the page
// has not changed since. If the held read advanced the fingerprint, the
// unchanged-page gate would skip every later read and the drop would never
// be confirmed.
test("a held big drop is confirmed on the next check of an unchanged page", async () => {
  const { check, alertsScheduled, scoreCalls } = await onUnchangedPage([{ inStock: true, price: 9900, currency: "GBP" }]);

  await check();
  expect(await alertsScheduled()).toBe(0);
  await check();
  expect(await alertsScheduled()).toBe(1);
  await check();
  expect(await alertsScheduled()).toBe(1);
  expect(scoreCalls()).toBe(2);
});

const HELD = { inStock: true, price: 9900, currency: "GBP" };
const NO_PRICE = { inStock: true, price: null, currency: null };

// A held price that stayed held for good would keep the old fingerprint, and
// force a paid read on every check, forever.
test("a held big drop whose confirming read shows another price is dropped at once", async () => {
  const { t, id, check, alertsScheduled, scoreCalls } = await onUnchangedPage([HELD, { ...HELD, price: 5000 }]);

  for (let i = 0; i < 4; i++) await check();

  expect(scoreCalls()).toBe(2);
  expect(await alertsScheduled()).toBe(0);
  const monitor = await t.run((ctx) => ctx.db.get(id));
  expect(monitor?.lastSeen).toEqual({ inStock: true, price: 29900, currency: "GBP" });
  expect(monitor?.productFingerprint).toBe("product-2");
});

test("a held big drop gives up after three confirming reads with no price", async () => {
  const { t, id, check, alertsScheduled, scoreCalls } = await onUnchangedPage([HELD, NO_PRICE]);

  for (let i = 0; i < 6; i++) await check();

  expect(scoreCalls()).toBe(4);
  expect(await alertsScheduled()).toBe(0);
  const monitor = await t.run((ctx) => ctx.db.get(id));
  expect(monitor?.lastSeen).toEqual({ inStock: true, price: 29900, currency: "GBP" });
  expect(monitor?.productFingerprint).toBe("product-2");
});

// One read that misses the price is a glitch, not a reason to lose a real sale.
test("a held big drop survives a confirming read with no price, and is confirmed by the next", async () => {
  const { check, alertsScheduled, scoreCalls } = await onUnchangedPage([HELD, NO_PRICE, HELD]);

  for (let i = 0; i < 4; i++) await check();

  expect(scoreCalls()).toBe(3);
  expect(await alertsScheduled()).toBe(1);
});

// A page that moves to a new currency and then stops changing would leave
// the switch unconfirmed, and the old price frozen, until the page next moved.
test("a read in a new currency is confirmed on the next check of an unchanged page", async () => {
  const { t, id, check, alertsScheduled, scoreCalls } = await onUnchangedPage([{ inStock: true, price: 35000, currency: "USD" }]);

  for (let i = 0; i < 3; i++) await check();

  expect(scoreCalls()).toBe(2);
  expect(await alertsScheduled()).toBe(0);
  const monitor = await t.run((ctx) => ctx.db.get(id));
  expect(monitor?.lastSeen).toEqual({ inStock: true, price: 35000, currency: "USD" });
  expect(monitor?.productFingerprint).toBe("product-2");
});

test("a read in a new currency gives up after three confirming reads with no price", async () => {
  const { t, id, check, scoreCalls } = await onUnchangedPage([{ inStock: true, price: 35000, currency: "USD" }, NO_PRICE]);

  for (let i = 0; i < 6; i++) await check();

  expect(scoreCalls()).toBe(4);
  const monitor = await t.run((ctx) => ctx.db.get(id));
  expect(monitor?.lastSeen).toEqual({ inStock: true, price: 29900, currency: "GBP" });
  expect(monitor?.productFingerprint).toBe("product-2");
});

/**
 * A listing monitor whose prompt asks for stock, on a page whose one matching
 * entry reads `stocks` in turn across checks. The page changes every check.
 */
async function stockListing(stocks: boolean[], soldOutScore = 20) {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  let checkNo = 0;
  const readStockSent: boolean[] = [];
  const entry = { title: "Kingston FURY Beast 16GB DDR5-6000", url: "https://shop.test/kingston", price: 199, snippet: "" };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/quick-check")) {
      checkNo++;
      return Response.json({ accessible: true, contentHash: `page-${checkNo}`, candidates: [entry], totalEntries: 9 });
    }
    if (url.endsWith("/api/score")) {
      readStockSent.push(JSON.parse(String(init?.body)).readStock === true);
      const inStock = stocks[Math.min(checkNo - 1, stocks.length - 1)];
      return Response.json({
        scored: [{ ...entry, matchScore: inStock ? 95 : soldOutScore, matchReason: "", stock: { inStock, price: 19900, currency: "NZD" } }],
      });
    }
    return new Response("not mocked", { status: 500 });
  });

  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const id = await t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId: "user_1",
      name: "PC build: RAM",
      url: "https://shop.test/ram",
      prompt: "in stock at NZ$220 or less",
      status: "active",
      checkInterval: "1h",
      schema: { items: [], matchConditions: { mustInclude: ["Kingston"], priceMax: 220, inStockOnly: true } },
      matchCount: 0,
      candidateKeys: [],
      checkCount: 5,
      contentFingerprint: "page-0",
      lastAiExtractAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const check = async () => {
    await t.run((ctx) => ctx.db.patch(id, { nextCheckAt: 0 }));
    await t.action(internal.scheduler.runScheduledChecks, {});
    return t.run((ctx) => ctx.db.get(id));
  };
  return { check, readStockSent };
}

// Story 2: a sold-out item the user asked for must alert when it comes back.
// Marking it seen while sold out meant it was never judged again.
test("a sold-out entry is judged again, and alerts when it comes back in stock", async () => {
  const { check, readStockSent } = await stockListing([false, false, true]);

  const first = await check();
  expect(first?.lastMatchAt).toBeUndefined();
  expect(first?.candidateKeys).toEqual([]);
  expect((await check())?.lastMatchAt).toBeUndefined();
  expect((await check())?.lastMatchAt).toBeDefined();
  expect(readStockSent).toEqual([true, true, true]);
});

// Once it alerted, the entry is seen like any other: no repeat every check.
test("an in-stock entry is judged once", async () => {
  const { check, readStockSent } = await stockListing([true]);
  await check();
  await check();
  expect(readStockSent).toEqual([true]);
});

// The score is the model's judgement; the stock read is a fact. A high score
// on a sold-out entry must not send an alert.
test("a sold-out entry never alerts, whatever it scored", async () => {
  const { check } = await stockListing([false], 95);
  expect((await check())?.lastMatchAt).toBeUndefined();
});
