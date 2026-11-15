/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";
import type { Doc } from "./_generated/dataModel";
import { stockNotShownNote } from "@prowl/shared";

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
// The real scorer marks a sold-out entry down when the prompt wants stock.
async function stockListing(stocks: boolean[], soldOutScore = 20) {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  let checkNo = 0;
  const readStockSent: boolean[] = [];
  const stockAt = () => stocks[Math.min(checkNo - 1, stocks.length - 1)]!;
  // The entry's own text says whether it is in stock, as on a real page.
  const entry = () => ({
    title: "Kingston FURY Beast 16GB DDR5-6000",
    url: "https://shop.test/kingston",
    price: 199,
    snippet: stockAt() ? "In stock" : "Sold out",
  });
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/quick-check")) {
      checkNo++;
      return Response.json({ accessible: true, contentHash: `page-${checkNo}`, candidates: [entry()], totalEntries: 9 });
    }
    if (url.endsWith("/api/score")) {
      readStockSent.push(JSON.parse(String(init?.body)).readStock === true);
      const inStock = stockAt();
      return Response.json({
        scored: [{ ...entry(), matchScore: inStock ? 95 : soldOutScore, matchReason: "", stock: { inStock, price: 19900, currency: "NZD" } }],
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
  return { t, id, check, readStockSent };
}

// Story 2: a sold-out item the user asked for must alert when it comes back.
// Marking it seen while sold out meant it was never judged again.
test("a sold-out entry is judged again, and alerts when it comes back in stock", async () => {
  const { check, readStockSent } = await stockListing([false, false, true]);

  const first = await check();
  expect(first?.lastMatchAt).toBeUndefined();
  expect(first?.soldOutKeys).toEqual(["shop.test/kingston"]);
  expect((await check())?.lastMatchAt).toBeUndefined();
  expect((await check())?.lastMatchAt).toBeDefined();
  // Judged when new, then again only when its own text changed.
  expect(readStockSent).toEqual([true, true]);
});

// Each recheck is a paid scoring call. A sold-out entry whose own text has
// not changed cannot have come back, so it costs nothing, however often the
// rest of the page changes.
test("a sold-out entry is not rechecked while its own text is unchanged", async () => {
  const { check, readStockSent } = await stockListing([false]);
  for (let i = 0; i < 3; i++) await check();
  expect(readStockSent).toEqual([true]);
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

// The Computer Lounge pages list the product after a related item. The read
// must find the product by its own link, not take the first item on the page.
test("a product page with related items reads the product's stock, by its own title", async () => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  const sent: { productTitle?: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/quick-check")) {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ accessible: true, contentHash: "page-1", candidates: [], totalEntries: 9 });
    }
    return new Response("not mocked", { status: 500 });
  });
  const page = "https://computerlounge.co.nz/products/noctua-nh-l9a-am5-cpu-cooler";
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  await t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId: "user_1",
      name: "PC build: Noctua",
      url: page,
      prompt: "back in stock up to NZ$95",
      status: "active",
      checkInterval: "1h",
      schema: {
        items: [
          { title: "Noctua NH-L9a-AM5 Chromax Black", url: "https://computerlounge.co.nz/products/noctua-nh-l9a-am5-chromax-black-cpu-cooler" },
          { title: "Noctua NH-L9a-AM5 Low Profile CPU Cooler", url: page },
        ],
      },
      matchCount: 0,
      alertOn: { backInStock: true },
      checkCount: 5,
      lastAiExtractAt: Date.now(),
      nextCheckAt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  await t.action(internal.scheduler.runScheduledChecks, {});
  expect(sent[0]?.productTitle).toBe("Noctua NH-L9a-AM5 Low Profile CPU Cooler");
});

// A page full of sold-out matches must not starve a new arrival of its turn
// to be judged, and must not grow the per-check scoring bill without limit.
test("re-judging sold-out entries is capped, and new entries go first", async () => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  const soldOut = Array.from({ length: 30 }, (_, i) => ({
    title: `Kingston kit ${i}`,
    url: `https://shop.test/kingston-${i}`,
    price: 199,
    snippet: "",
  }));
  const fresh = { title: "Kingston kit new", url: "https://shop.test/kingston-new", price: 199, snippet: "" };
  const judged: string[][] = [];
  let checkNo = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/quick-check")) {
      checkNo++;
      return Response.json({ accessible: true, contentHash: `page-${checkNo}`, candidates: [...soldOut, fresh], totalEntries: 31 });
    }
    if (url.endsWith("/api/score")) {
      const { candidates } = JSON.parse(String(init?.body)) as { candidates: { url: string }[] };
      judged.push(candidates.map((c) => c.url));
      return Response.json({
        scored: candidates.map((c) => ({ ...c, matchScore: 20, matchReason: "", stock: { inStock: false, price: 19900, currency: "NZD" } })),
      });
    }
    return new Response("not mocked", { status: 500 });
  });
  const keys = soldOut.map((c) => c.url.replace("https://", ""));
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const id = await t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId: "user_1",
      name: "RAM",
      url: "https://shop.test/ram",
      prompt: "in stock",
      status: "active",
      checkInterval: "1h",
      schema: { items: [], matchConditions: { mustInclude: ["Kingston"], inStockOnly: true } },
      matchCount: 0,
      candidateKeys: keys,
      soldOutKeys: keys,
      checkCount: 5,
      contentFingerprint: "page-0",
      lastAiExtractAt: Date.now(),
      nextCheckAt: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  await t.action(internal.scheduler.runScheduledChecks, {});
  expect(judged[0]).toEqual([fresh.url, ...soldOut.slice(0, 5).map((c) => c.url)]);

  // The next check moves on to the next five, so every sold-out entry gets a turn.
  await t.run((ctx) => ctx.db.patch(id, { nextCheckAt: 0 }));
  await t.action(internal.scheduler.runScheduledChecks, {});
  expect(judged[1]).toEqual(soldOut.slice(5, 10).map((c) => c.url));
});

// A recheck exists to catch a restock. When the scorer fails or reads no stock,
// nothing says it came back, so it must stay sold out: no alert, still queued.
test("a sold-out entry whose recheck reads no stock stays sold out", async () => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  const entry = { title: "Kingston FURY Beast 16GB DDR5-6000", url: "https://shop.test/kingston", price: 199, snippet: "" };
  const answers = [
    () => new Response("down", { status: 500 }),
    () => Response.json({ scored: [{ ...entry, matchScore: 95, matchReason: "", stock: { inStock: null, price: 19900, currency: "NZD" } }] }),
  ];
  let checkNo = 0;
  let scoreCalls = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/api/quick-check")) {
      checkNo++;
      return Response.json({ accessible: true, contentHash: `page-${checkNo}`, candidates: [entry], totalEntries: 9 });
    }
    if (url.endsWith("/api/score")) {
      scoreCalls++;
      return answers[checkNo - 1]!();
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
      schema: { items: [], matchConditions: { mustInclude: ["Kingston"], inStockOnly: true } },
      matchCount: 0,
      candidateKeys: ["shop.test/kingston"],
      soldOutKeys: ["shop.test/kingston"],
      checkCount: 5,
      contentFingerprint: "page-0",
      lastAiExtractAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  for (let i = 0; i < answers.length; i++) {
    await t.run((ctx) => ctx.db.patch(id, { nextCheckAt: 0 }));
    await t.action(internal.scheduler.runScheduledChecks, {});
    const monitor = await t.run((ctx) => ctx.db.get(id));
    expect(monitor?.lastMatchAt).toBeUndefined();
    expect(monitor?.soldOutKeys).toEqual(["shop.test/kingston"]);
  }
  // The failed read is tried again; the blank one waits for the entry's own
  // text to change, or every page change would pay for it again.
  await t.run((ctx) => ctx.db.patch(id, { nextCheckAt: 0 }));
  await t.action(internal.scheduler.runScheduledChecks, {});
  expect(scoreCalls).toBe(2);
});

// The quick check alerted on it, so the next full read must not announce it again.
test("an entry a quick check alerted on is not announced again by the next full read", async () => {
  const { t, id, check } = await stockListing([true]);
  await t.run((ctx) => ctx.db.patch(id, { matchedKeys: [] }));
  expect((await check())?.matchedKeys).toEqual(["shop.test/kingston"]);
});

/** A monitor on a page with Kingston sold out per quick checks, due a full read that returns `items`. */
async function fullReadAfterQuickChecks(items: Record<string, unknown>[]) {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/api/quick-check")) return Response.json({ accessible: true, contentHash: "page-2", candidates: [], totalEntries: 1 });
    if (url.endsWith("/api/extract")) {
      return Response.json({ schema: { items, matchConditions: { inStockOnly: true } }, matches: [], totalItems: items.length, contentHash: "page-2" });
    }
    return new Response("not mocked", { status: 500 });
  });
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const id = await t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId: "user_1", name: "RAM", url: "https://shop.test/ram", prompt: "in stock", status: "active", checkInterval: "1h",
      schema: { items: [], matchConditions: { inStockOnly: true } }, matchCount: 0, matchedKeys: [],
      candidateKeys: ["shop.test/kingston"], soldOutKeys: ["shop.test/kingston"],
      checkCount: 5, contentFingerprint: "page-1", lastAiExtractAt: 0, nextCheckAt: 0, createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  await t.action(internal.scheduler.runScheduledChecks, {});
  return (await t.run((ctx) => ctx.db.get(id)))?.soldOutKeys;
}

// A full read that does not say the entry is back must not drop it from the
// rechecks: it is already seen, so nothing else would ever judge it again.
test("a full read keeps a sold-out entry it did not read as back in stock", async () => {
  expect(await fullReadAfterQuickChecks([{ title: "Kingston", url: "https://shop.test/kingston", inStock: null }])).toEqual(["shop.test/kingston"]);
  expect(await fullReadAfterQuickChecks([])).toEqual(["shop.test/kingston"]);
});

test("a full read drops a sold-out entry it reads as back in stock", async () => {
  expect(await fullReadAfterQuickChecks([{ title: "Kingston", url: "https://shop.test/kingston", inStock: true }])).toEqual([]);
});

// The stock alert already reports a product page's restock. A recheck would
// send a second alert for the same event.
test("a product page with a stock alert gets no sold-out rechecks", async () => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  const page = "https://shop.test/kingston";
  const entry = { title: "Kingston FURY Beast", url: page, price: 199, snippet: "" };
  // A related item new to the page, so the check scores and writes.
  const related = { title: "Kingston FURY Renegade", url: "https://shop.test/renegade", price: 249, snippet: "" };
  const judged: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/quick-check")) return Response.json({ accessible: true, contentHash: "page-2", candidates: [entry, related], totalEntries: 2 });
    if (url.endsWith("/api/score")) {
      const { candidates } = JSON.parse(String(init?.body)) as { candidates: { url: string }[] };
      judged.push(...candidates.map((c) => c.url));
      return Response.json({
        scored: candidates.map((c) => ({ ...c, matchScore: 20, matchReason: "", stock: { inStock: true, price: 24900, currency: "NZD" } })),
      });
    }
    return new Response("not mocked", { status: 500 });
  });
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const id = await t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId: "user_1", name: "RAM", url: page, prompt: "in stock", status: "active", checkInterval: "1h",
      schema: { items: [{ title: "Kingston FURY Beast", url: page }], matchConditions: { inStockOnly: true } },
      matchCount: 0, alertOn: { backInStock: true }, candidateKeys: ["shop.test/kingston"], soldOutKeys: ["shop.test/kingston"],
      productFingerprint: "same", checkCount: 5, contentFingerprint: "page-1", lastAiExtractAt: Date.now(), nextCheckAt: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  await t.action(internal.scheduler.runScheduledChecks, {});
  expect(judged).toEqual([related.url]);
  // The queue is kept, for if the stock alert is turned off later.
  expect((await t.run((ctx) => ctx.db.get(id)))?.soldOutKeys).toEqual(["shop.test/kingston"]);
});

// The prompt asked for stock, and the scorer could not read it. The alert
// must say so, or it reads as an in-stock match.
test("a quick-check alert with no stock read says stock was not shown", async () => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  const entry = { title: "Kingston FURY Beast 16GB DDR5-6000", url: "https://shop.test/kingston", price: 199, snippet: "NZ$199" };
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/api/quick-check")) return Response.json({ accessible: true, contentHash: "page-2", candidates: [entry], totalEntries: 9 });
    if (url.endsWith("/api/score")) {
      return Response.json({ scored: [{ ...entry, matchScore: 90, matchReason: "", stock: { inStock: null, price: 19900, currency: "NZD" } }] });
    }
    return new Response("not mocked", { status: 500 });
  });
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const id = await t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId: "user_1", name: "PC build: RAM", url: "https://shop.test/ram", prompt: "in stock", status: "active", checkInterval: "1h",
      schema: { items: [], matchConditions: { mustInclude: ["Kingston"], inStockOnly: true } }, matchCount: 0, candidateKeys: [],
      checkCount: 5, contentFingerprint: "page-1", lastAiExtractAt: Date.now(), nextCheckAt: 0, createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  await t.action(internal.scheduler.runScheduledChecks, {});
  // The alert's note is built from the stored matches.
  const [row] = await t.run((ctx) => ctx.db.query("scrapeResults").withIndex("by_monitorId", (q) => q.eq("monitorId", id)).collect());
  expect(stockNotShownNote(row!.matches, { inStockOnly: true })).toMatch(/Stock not shown/);
});

// The prompt asks for stock and the scorer did not answer. Alerting on every
// new entry would send sold-out ones too. They wait for the next check instead.
test("a stock-aware check whose scoring fails holds new entries for the next check", async () => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  const entry = { title: "Kingston FURY Beast 16GB DDR5-6000", url: "https://shop.test/kingston", price: 199, snippet: "Sold out" };
  let checkNo = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/api/quick-check")) {
      checkNo++;
      return Response.json({ accessible: true, contentHash: `page-${checkNo}`, candidates: [entry], totalEntries: 9 });
    }
    if (url.endsWith("/api/score")) {
      if (checkNo === 1) return new Response("down", { status: 500 });
      return Response.json({ scored: [{ ...entry, matchScore: 20, matchReason: "", stock: { inStock: false, price: 19900, currency: "NZD" } }] });
    }
    return new Response("not mocked", { status: 500 });
  });
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const id = await t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId: "user_1", name: "PC build: RAM", url: "https://shop.test/ram", prompt: "in stock", status: "active", checkInterval: "1h",
      schema: { items: [], matchConditions: { mustInclude: ["Kingston"], inStockOnly: true } }, matchCount: 0, candidateKeys: [],
      checkCount: 5, contentFingerprint: "page-0", lastAiExtractAt: Date.now(), createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const check = async () => {
    await t.run((ctx) => ctx.db.patch(id, { nextCheckAt: 0 }));
    await t.action(internal.scheduler.runScheduledChecks, {});
    return t.run((ctx) => ctx.db.get(id));
  };
  const failed = await check();
  expect(failed?.lastMatchAt).toBeUndefined();
  expect(failed?.candidateKeys).toEqual([]);
  // Judged on the next check: sold out, so queued, and still no alert.
  const judged = await check();
  expect(judged?.lastMatchAt).toBeUndefined();
  expect(judged?.soldOutKeys).toEqual(["shop.test/kingston"]);
});

// A product page with stock or price alerts reports its product through
// them. Announced as a match as well, one restock or price drop would alert
// twice, whichever read saw it first. Related items still alert as matches.
test("a full read never announces the product itself when its stock or price alerts are on", async () => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  const page = "https://shop.test/noctua";
  const product = { title: "Noctua NH-L9a-AM5", url: page, price: 89, inStock: true };
  const related = { title: "Noctua NH-L12S", url: "https://shop.test/l12s", price: 109, inStock: true };
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/api/quick-check")) return Response.json({ accessible: true, contentHash: "page-2", candidates: [], totalEntries: 2 });
    if (url.endsWith("/api/extract")) {
      return Response.json({ schema: { items: [product, related], matchConditions: { inStockOnly: true } }, matches: [product, related], totalItems: 2, contentHash: "page-2" });
    }
    return new Response("not mocked", { status: 500 });
  });
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const id = await t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId: "user_1", name: "Noctua", url: page, prompt: "back in stock", status: "active", checkInterval: "1h",
      schema: { items: [{ ...product, inStock: false }, related], matchConditions: { inStockOnly: true } }, matchCount: 0,
      alertOn: { backInStock: true }, matchedKeys: [], checkCount: 5, contentFingerprint: "page-1", lastAiExtractAt: 0, nextCheckAt: 0,
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  await t.action(internal.scheduler.runScheduledChecks, {});
  const [row] = await t.run((ctx) => ctx.db.query("scrapeResults").withIndex("by_monitorId", (q) => q.eq("monitorId", id)).collect());
  expect(row?.newMatchKeys).toEqual(["shop.test/l12s"]);
});

// Only a stock alert reports a restock. With price alerts alone, the full
// read's match is the only alert the restock gets, so it must not be dropped.
test("a full read announces the product's restock when only price alerts are on", async () => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  const page = "https://shop.test/noctua";
  const product = { title: "Noctua NH-L9a-AM5", url: page, price: 89, inStock: true };
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/api/quick-check")) return Response.json({ accessible: true, contentHash: "page-2", candidates: [], totalEntries: 1 });
    if (url.endsWith("/api/extract")) {
      return Response.json({ schema: { items: [product], matchConditions: { inStockOnly: true } }, matches: [product], totalItems: 1, contentHash: "page-2" });
    }
    return new Response("not mocked", { status: 500 });
  });
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const id = await t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId: "user_1", name: "Noctua", url: page, prompt: "in stock under NZ$95", status: "active", checkInterval: "1h",
      schema: { items: [{ ...product, inStock: false }], matchConditions: { inStockOnly: true } }, matchCount: 0,
      alertOn: { priceBelow: { amount: 9500, currency: "NZD" } }, matchedKeys: [], checkCount: 5, contentFingerprint: "page-1",
      lastAiExtractAt: 0, nextCheckAt: 0, createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  await t.action(internal.scheduler.runScheduledChecks, {});
  const [row] = await t.run((ctx) => ctx.db.query("scrapeResults").withIndex("by_monitorId", (q) => q.eq("monitorId", id)).collect());
  expect(row?.newMatchKeys).toEqual(["shop.test/noctua"]);
});

// Without "in stock only", a restock makes no new match: the product matched
// while sold out too. So a new match there is a price change, the only alert
// it gets when price alerts are off, and it must not be dropped.
test("a full read announces the product's price crossing when only the stock alert is on", async () => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  const page = "https://shop.test/noctua";
  const product = { title: "Noctua NH-L9a-AM5", url: page, price: 89, inStock: true };
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.endsWith("/api/quick-check")) return Response.json({ accessible: true, contentHash: "page-2", candidates: [], totalEntries: 1 });
    if (url.endsWith("/api/extract")) {
      return Response.json({ schema: { items: [product], matchConditions: { priceMax: 95 } }, matches: [product], totalItems: 1, contentHash: "page-2" });
    }
    return new Response("not mocked", { status: 500 });
  });
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const id = await t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId: "user_1", name: "Noctua", url: page, prompt: "under NZ$95", status: "active", checkInterval: "1h",
      schema: { items: [{ ...product, price: 99 }], matchConditions: { priceMax: 95 } }, matchCount: 0,
      alertOn: { backInStock: true }, lastSeen: { inStock: true }, matchedKeys: [], checkCount: 5, contentFingerprint: "page-1",
      lastAiExtractAt: 0, nextCheckAt: 0, createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  await t.action(internal.scheduler.runScheduledChecks, {});
  const [row] = await t.run((ctx) => ctx.db.query("scrapeResults").withIndex("by_monitorId", (q) => q.eq("monitorId", id)).collect());
  expect(row?.newMatchKeys).toEqual(["shop.test/noctua"]);
});

type Offer = { title: string; url: string; price: number | null; snippet: string };

/**
 * A listing monitor with no stock condition, whose page shows `pages[n]` on
 * check n+1 (the last repeats) and changes every check. The scorer gives each
 * entry `score(entry)`. Returns the URLs sent to each scoring call.
 */
async function offerListing(pages: Offer[][], score: (entry: Offer) => number | null, seed: Partial<Doc<"monitors">> = {}) {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  let checkNo = 0;
  const judged: string[][] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/quick-check")) {
      checkNo++;
      const candidates = pages[Math.min(checkNo - 1, pages.length - 1)]!;
      return Response.json({ accessible: true, contentHash: `page-${checkNo}`, candidates, totalEntries: candidates.length });
    }
    if (url.endsWith("/api/score")) {
      const { candidates } = JSON.parse(String(init?.body)) as { candidates: Offer[] };
      judged.push(candidates.map((c) => c.url));
      return Response.json({ scored: candidates.map((c) => ({ ...c, matchScore: score(c), matchReason: "" })) });
    }
    return new Response("not mocked", { status: 500 });
  });
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const id = await t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId: "user_1",
      name: "PC build: motherboard",
      url: "https://pricespy.co.nz/product.php?p=1",
      prompt: "Any shop offers the Gigabyte B650I AX for under NZ$310.",
      status: "active",
      checkInterval: "1h",
      schema: { items: [], matchConditions: { mustInclude: ["B650I"], priceMax: 310 } },
      matchCount: 0,
      candidateKeys: [],
      matchedKeys: [],
      checkCount: 5,
      contentFingerprint: "page-0",
      lastAiExtractAt: Date.now(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...seed,
    })
  );
  const check = async () => {
    await t.run((ctx) => ctx.db.patch(id, { nextCheckAt: 0 }));
    await t.action(internal.scheduler.runScheduledChecks, {});
    return t.run((ctx) => ctx.db.get(id));
  };
  return { t, id, check, judged };
}

const pbtech = (price: number): Offer => ({ title: "PB Tech B650I AX", url: "https://pricespy.co.nz/go/pbtech", price, snippet: "In stock" });
const under310 = (entry: Offer) => (entry.price !== null && entry.price < 310 ? 90 : 20);

// Prod, 14/11/2026: PB Tech dropped the motherboard to $309.35, under the
// user's $310. Its offer had been seen before, and a seen entry was never
// judged again, so the prompt never alerted.
test("a seen entry that has not alerted is judged again when its price changes, and alerts once it qualifies", async () => {
  const { check, judged } = await offerListing([[pbtech(329)], [pbtech(329)], [pbtech(309.35)]], under310, {
    candidateKeys: ["pricespy.co.nz/go/pbtech"],
  });
  // No price on record yet, then the same price: nothing to judge.
  expect((await check())?.lastMatchAt).toBeUndefined();
  expect((await check())?.lastMatchAt).toBeUndefined();
  expect(judged).toEqual([]);

  expect((await check())?.lastMatchAt).toBeDefined();
  expect(judged).toEqual([["https://pricespy.co.nz/go/pbtech"]]);
});

// Each judgement is a paid call, and an entry that already alerted would
// alert again on every price wobble.
test("an entry that already alerted is not judged again when its price changes", async () => {
  const { check, judged } = await offerListing([[pbtech(305)], [pbtech(299)]], under310, {
    candidateKeys: ["pricespy.co.nz/go/pbtech"],
    passedKeys: ["pricespy.co.nz/go/pbtech"],
  });
  await check();
  await check();
  expect(judged).toEqual([]);
});

// A scoring outage lets new entries through unjudged. A seen entry has
// already had its judgement, so an unjudged price change must not alert, and
// must be judged again on the next check.
test("a price change the scorer did not judge does not alert, and is judged next check", async () => {
  let fail = true;
  const { check, judged } = await offerListing([[pbtech(329)], [pbtech(309)]], (e) => (fail ? null : under310(e)), {
    candidateKeys: ["pricespy.co.nz/go/pbtech"],
  });
  await check();
  expect((await check())?.lastMatchAt).toBeUndefined();
  fail = false;
  expect((await check())?.lastMatchAt).toBeDefined();
  expect(judged).toHaveLength(2);
});

// A product's listing alerts on stock and price through its product read, never
// on its page's entries, so judging them again would buy nothing.
test("a product's listing does not judge seen entries again on a price change", async () => {
  const { t, check, judged } = await offerListing([[pbtech(329)], [pbtech(309)]], under310, {
    candidateKeys: ["pricespy.co.nz/go/pbtech"],
  });
  const groupId = await t.run((ctx) =>
    ctx.db.insert("monitorGroups", {
      userId: "user_1", name: "B650I", region: "NZ", alertOn: { priceDrop: true }, checkInterval: "1h", listings: [], createdAt: 0, updatedAt: 0,
    })
  );
  await t.run(async (ctx) => {
    const [monitor] = await ctx.db.query("monitors").collect();
    await ctx.db.patch(monitor!._id, { groupId });
  });
  await check();
  await check();
  expect(judged).toEqual([]);
});

// Prod, 14/11/2026: the motherboard showed 4 matches that were a category
// link, two info pages and one offer, none of which the AI had passed.
test("the match count is the entries on the page that passed the AI, not every keyword hit", async () => {
  const info = (n: number): Offer => ({ title: `B650I info ${n}`, url: `https://pricespy.co.nz/info/${n}`, price: null, snippet: "" });
  const kept: Offer = { title: "Mighty Ape B650I AX", url: "https://pricespy.co.nz/go/mightyape", price: 305, snippet: "In stock" };
  const { check } = await offerListing([[info(1), info(2), pbtech(329), kept], [info(1), info(2), pbtech(329), kept, info(3)]], under310, {
    candidateKeys: ["pricespy.co.nz/go/pbtech"],
  });
  // Two new info pages fail, the new Mighty Ape offer passes, PB Tech is seen.
  expect((await check())?.matchCount).toBe(1);
  // Still on the page, still counted, though not judged again.
  expect((await check())?.matchCount).toBe(1);
  // Nothing new at all: the count still comes from what passed.
  expect((await check())?.matchCount).toBe(1);
});

// A first scan clears matchedKeys, and only a full read 14 days on rebuilds
// it. What the first scan passed has to count, and must not be judged again
// on a price change, all through that time.
test("a first scan's matches count and are not judged again until the next full read", async () => {
  const kept: Offer = { title: "Mighty Ape B650I AX", url: "https://pricespy.co.nz/go/mightyape", price: 305, snippet: "In stock" };
  const { check, judged } = await offerListing([[{ ...kept, price: 299 }]], under310, {
    candidateKeys: ["pricespy.co.nz/go/mightyape"],
    candidatePrices: [{ key: "pricespy.co.nz/go/mightyape", price: 305 }],
    matchedKeys: undefined,
    passedKeys: ["pricespy.co.nz/go/mightyape"],
  });
  expect((await check())?.matchCount).toBe(1);
  expect(judged).toEqual([]);
});

// Monitors from before passedKeys have only matchedKeys to go on.
test("without passedKeys, what matchedKeys holds counts", async () => {
  const kept: Offer = { title: "Mighty Ape B650I AX", url: "https://pricespy.co.nz/go/mightyape", price: 305, snippet: "In stock" };
  const { check } = await offerListing([[kept]], under310, {
    candidateKeys: ["pricespy.co.nz/go/mightyape"],
    matchedKeys: ["pricespy.co.nz/go/mightyape"],
  });
  expect((await check())?.matchCount).toBe(1);
});

test("what a quick check passes is added to passedKeys, and a full read replaces them", async () => {
  const kept: Offer = { title: "Mighty Ape B650I AX", url: "https://pricespy.co.nz/go/mightyape", price: 305, snippet: "In stock" };
  const { t, id, check } = await offerListing([[kept]], under310, { passedKeys: ["shop.test/older"] });
  expect((await check())?.passedKeys).toEqual(["shop.test/older", "pricespy.co.nz/go/mightyape"]);

  await t.mutation(internal.scheduler.recordCheckResult, {
    monitorId: id, hasNewMatches: true, matchCount: 1, totalItems: 3, matches: [{ title: "Only", url: "https://shop.test/only" }], trackMatchKeys: true,
  });
  expect((await t.run((ctx) => ctx.db.get(id)))?.passedKeys).toEqual(["shop.test/only"]);
});

// A price change can only bring an entry into a prompt that bounds the price.
// On pages whose prices move on every load, judging them all would buy a
// scoring call every check.
test("a prompt with no price limit does not judge seen entries again on a price change", async () => {
  const { check, judged } = await offerListing([[pbtech(329)], [pbtech(309)]], under310, {
    candidateKeys: ["pricespy.co.nz/go/pbtech"],
    schema: { items: [], matchConditions: { mustInclude: ["B650I"] } },
  });
  await check();
  await check();
  expect(judged).toEqual([]);
});

// The product read already alerts on its price. Judging the product's own
// entry again would send the same drop a second time, as a match.
test("a product page with a price alert does not judge entries again on a price change", async () => {
  const page = "https://shop.test/b650i";
  const own: Offer = { title: "Gigabyte B650I AX", url: page, price: 329, snippet: "In stock" };
  const { check, judged } = await offerListing([[own], [{ ...own, price: 299 }]], under310, {
    url: page,
    alertOn: { priceDrop: true },
    candidateKeys: ["shop.test/b650i"],
    schema: { items: [{ title: own.title, url: page }], matchConditions: { mustInclude: ["B650I"], priceMax: 310 } },
  });
  await check();
  await check();
  expect(judged).toEqual([]);
});

// A queued sold-out entry is the restock queue's to judge, which needs a read
// that says it is back. Judged as repriced, a blank stock read let it alert.
test("an entry in the sold-out queue is not judged again as repriced", async () => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
  const entries = Array.from({ length: 6 }, (_, i) => ({ title: `Kingston kit ${i}`, url: `https://shop.test/k-${i}`, price: 199, snippet: "" }));
  const judged: string[][] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/quick-check")) {
      return Response.json({ accessible: true, contentHash: "page-1", candidates: entries, totalEntries: 6 });
    }
    if (url.endsWith("/api/score")) {
      const { candidates } = JSON.parse(String(init?.body)) as { candidates: Offer[] };
      judged.push(candidates.map((c) => c.url));
      return Response.json({ scored: candidates.map((c) => ({ ...c, matchScore: 90, matchReason: "", stock: { inStock: null, price: null, currency: null } })) });
    }
    return new Response("not mocked", { status: 500 });
  });
  const keys = entries.map((c) => c.url.replace("https://", ""));
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const id = await t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId: "user_1", name: "RAM", url: "https://shop.test/ram", prompt: "in stock under $220", status: "active", checkInterval: "1h",
      schema: { items: [], matchConditions: { mustInclude: ["Kingston"], priceMax: 220, inStockOnly: true } },
      matchCount: 0, candidateKeys: keys, soldOutKeys: keys, matchedKeys: [],
      candidatePrices: keys.map((key) => ({ key, price: 219 })),
      checkCount: 5, contentFingerprint: "page-0", lastAiExtractAt: Date.now(), nextCheckAt: 0, createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  await t.action(internal.scheduler.runScheduledChecks, {});
  expect(judged[0]).toHaveLength(5);
  expect((await t.run((ctx) => ctx.db.get(id)))?.lastMatchAt).toBeUndefined();
});

// Prod, 14/11/2026: a product's first read is a full read, which records no
// price or stock. Only a quick check's product read does, and on a 24h
// interval that was a day away, so get_product showed nulls all day.
test("a product monitor's first full read brings its first price and stock read forward", async () => {
  const { t, id } = await seedProductMonitor(undefined);
  await t.run((ctx) => ctx.db.patch(id, { checkInterval: "24h" }));
  const now = Date.now();
  await t.mutation(internal.scheduler.recordCheckResult, {
    monitorId: id, hasNewMatches: false, matchCount: 0, totalItems: 1, matches: [], aiExtracted: true, trackMatchKeys: true,
    schema: { items: [{ title: "Sony WH-1000XM5" }] },
  });
  const read = await t.run((ctx) => ctx.db.get(id));
  expect(read?.nextCheckAt).toBeGreaterThanOrEqual(now + 60_000);
  expect(read?.nextCheckAt).toBeLessThan(now + 120_000);

  // Once it has a reading, the interval applies as usual.
  await t.run((ctx) => ctx.db.patch(id, { lastSeen: { inStock: true } }));
  await t.mutation(internal.scheduler.recordCheckResult, {
    monitorId: id, hasNewMatches: false, matchCount: 0, totalItems: 1, matches: [], aiExtracted: true, trackMatchKeys: true,
  });
  expect((await t.run((ctx) => ctx.db.get(id)))?.nextCheckAt).toBeGreaterThan(now + 23 * 3_600_000);
});
