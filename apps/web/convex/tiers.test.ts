/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

/** The checkout_completed events this test has scheduled, as their properties. */
async function sales(t: ReturnType<typeof setup>) {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs
    .filter((j) => j.name.includes("analytics") && (j.args[0] as { event: string }).event === "checkout_completed")
    .map((j) => (j.args[0] as { properties: Record<string, string> }).properties);
}

// The browser often never comes back from Polar's checkout, so a sale is only
// counted reliably here, on the webhook path. Without it PostHog never sees one.
test("a bought Sprint pass counts as one completed checkout, even if Polar redelivers it", async () => {
  const t = setup();
  const order = { userId: "user_1", tier: "sprint" as const, days: 30, orderId: "order_1" };
  await t.mutation(internal.tiers.grantPass, order);
  await t.mutation(internal.tiers.grantPass, order);
  expect(await sales(t)).toEqual([{ plan: "sprint", from: "free" }]);
});

test("a new subscription counts as one completed checkout, even if Polar redelivers it", async () => {
  const t = setup();
  const sub = { userId: "user_1", tier: "pro" as const, polarSubscriptionId: "sub_1" };
  await t.mutation(internal.tiers.update, sub);
  await t.mutation(internal.tiers.update, sub);
  expect(await sales(t)).toEqual([{ plan: "pro", from: "free" }]);
});

// Reconcile mutes the Telegram line because it sends its own summary. A sale
// it finds is still a sale whose webhook went missing, so it still counts.
test("a sale found by reconcile still counts", async () => {
  const t = setup();
  await t.mutation(internal.tiers.update, { userId: "user_1", tier: "max", polarSubscriptionId: "sub_1", silent: true });
  expect(await sales(t)).toEqual([{ plan: "max", from: "free" }]);
});

test("a subscription ending is not a sale", async () => {
  const t = setup();
  await t.mutation(internal.tiers.update, { userId: "user_1", tier: "pro", polarSubscriptionId: "sub_1" });
  await t.mutation(internal.tiers.update, { userId: "user_1", tier: "free", polarSubscriptionId: "sub_1" });
  expect(await sales(t)).toEqual([{ plan: "pro", from: "free" }]);
});
