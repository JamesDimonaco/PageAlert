/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

type Read = [price: number, currency: string, readAt: number];

async function seedMonitor(t: ReturnType<typeof setup>, userId: string, reads: Read[]) {
  return t.run(async (ctx) => {
    const last = reads[reads.length - 1];
    const id = await ctx.db.insert("monitors", {
      userId, name: "GPU", url: "https://shop.test/gpu", prompt: "x", status: "active", checkInterval: "1h",
      matchCount: 0, createdAt: 0, updatedAt: 0,
      ...(last ? { lastSeen: { price: last[0], currency: last[1] } } : {}),
    });
    for (const [price, currency, readAt] of reads) await ctx.db.insert("priceReads", { monitorId: id, price, currency, readAt });
    return id;
  });
}

// The point of the badge: a cheaper price shows even when no alert fired.
test("a fall from the previous price is a drop", async () => {
  const t = setup();
  const id = await seedMonitor(t, "u1", [[10000, "GBP", 1], [8000, "GBP", 2]]);
  expect(await t.withIdentity({ subject: "u1" }).query(api.priceMoves.listMine, {})).toEqual([
    { monitorId: id, from: 10000, to: 8000, currency: "GBP", changedAt: 2 },
  ]);
});

test("only the newest two reads count", async () => {
  const t = setup();
  const id = await seedMonitor(t, "u1", [[10000, "GBP", 1], [12000, "GBP", 2], [9000, "GBP", 3]]);
  expect(await t.withIdentity({ subject: "u1" }).query(api.priceMoves.listMine, {})).toEqual([
    { monitorId: id, from: 12000, to: 9000, currency: "GBP", changedAt: 3 },
  ]);
});

test("a rise, a first read or a currency switch is not a drop", async () => {
  const t = setup();
  await seedMonitor(t, "u1", [[8000, "GBP", 1], [9000, "GBP", 2]]);
  await seedMonitor(t, "u1", [[8000, "GBP", 1]]);
  await seedMonitor(t, "u1", [[10000, "USD", 1], [8000, "GBP", 2]]);
  await seedMonitor(t, "u1", []);
  expect(await t.withIdentity({ subject: "u1" }).query(api.priceMoves.listMine, {})).toEqual([]);
});

test("another user's drops stay hidden", async () => {
  const t = setup();
  await seedMonitor(t, "u2", [[10000, "GBP", 1], [8000, "GBP", 2]]);
  expect(await t.withIdentity({ subject: "u1" }).query(api.priceMoves.listMine, {})).toEqual([]);
  expect(await t.query(api.priceMoves.listMine, {})).toEqual([]);
});
