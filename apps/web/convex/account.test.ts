/// <reference types="vite/client" />
import { expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { MAX_LOG_ROW_BYTES } from "@prowl/shared";
import {
  deleteAllUserData,
  KEPT_ON_DELETE,
  SWEEP_BATCH,
  SWEPT_ON_DELETE,
} from "./account";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

const modules = import.meta.glob("./**/*.*s");

const LEAVING = "user_leaving";
const STAYING = "user_staying";

/**
 * Every table whose rows carry a userId, read off the schema rather than
 * listed here. A new table with a userId lands in this set the moment it is
 * defined, so the completeness test below fails until somebody decides
 * whether deletion should take it.
 */
function tablesCarryingUserId(): string[] {
  const tables = schema.tables as unknown as Record<
    string,
    { validator: { fields: Record<string, unknown> } }
  >;
  return Object.entries(tables)
    .filter(([, def]) => "userId" in def.validator.fields)
    .map(([name]) => name);
}

/** One row in each userId-carrying table, so deletion has something to miss. */
async function seed(ctx: MutationCtx, userId: string): Promise<Id<"monitors">> {
  const monitorId = await ctx.db.insert("monitors", {
    userId,
    name: "watch",
    url: "https://example.com/deals",
    prompt: "tell me about deals",
    status: "active",
    checkInterval: "1h",
    matchCount: 0,
    createdAt: 1,
    updatedAt: 1,
  });

  await ctx.db.insert("scrapeResults", {
    monitorId,
    matches: [],
    totalItems: 0,
    hasNewMatches: false,
    scrapedAt: 1,
  });
  await ctx.db.insert("notifications", {
    userId,
    monitorId,
    channel: "email",
    title: "match",
    message: "found one",
    sentAt: 1,
    read: false,
  });
  await ctx.db.insert("scrapeLogs", {
    userId,
    monitorId,
    url: "https://example.com/deals",
    prompt: "tell me about deals",
    status: "success",
    durationMs: 1,
    createdAt: 1,
  });
  await ctx.db.insert("matchFeedback", {
    userId,
    monitorId,
    itemKey: "https://example.com/deals/1",
    itemTitle: "a deal",
    verdict: "bad",
    prompt: "tell me about deals",
    source: "dashboard",
    createdAt: 1,
  });
  await ctx.db.insert("notificationSettings", {
    userId,
    channel: "email",
    enabled: true,
    target: `${userId}@example.com`,
  });
  await ctx.db.insert("userTiers", { userId, tier: "pro", updatedAt: 1 });
  await ctx.db.insert("pushSubscriptions", {
    userId,
    endpoint: `https://push.example.com/${userId}`,
    p256dh: "key",
    auth: "auth",
    createdAt: 1,
  });
  await ctx.db.insert("appliedOrders", { orderId: `order_${userId}`, userId, appliedAt: 1 });
  await ctx.db.insert("bannedUsers", {
    userId,
    email: `${userId}@example.com`,
    bannedBy: "admin@example.com",
    bannedAt: 1,
  });
  await ctx.db.insert("channelClaims", {
    channel: "telegram",
    target: userId,
    userId,
    claimedAt: 1,
  });
  await ctx.db.insert("reviews", {
    userId,
    displayName: "A Name",
    quote: "it works",
    createdAt: 1,
  });
  await ctx.db.insert("userActivity", { userId, lastSeenAt: 1 });
  await ctx.db.insert("monitorCreations", { userId, createdAt: 1 });
  await ctx.db.insert("emailSends", {
    to: `${userId}@example.com`,
    kind: "match",
    userId,
    status: "sent",
    createdAt: 1,
    updatedAt: 1,
  });
  await ctx.db.insert("onboardingEmails", {
    userId,
    email: `${userId}@example.com`,
    step: "day0",
    scheduledFor: 1,
    status: "pending",
  });

  return monitorId;
}

/** Rows still holding this userId, per table. */
async function remaining(ctx: MutationCtx, userId: string): Promise<string[]> {
  const left: string[] = [];
  for (const table of tablesCarryingUserId()) {
    const rows = (await ctx.db.query(table as TableNames).collect()) as Array<{ userId?: string }>;
    if (rows.some((row) => row.userId === userId)) left.push(table);
  }
  return left.sort();
}

/**
 * A round reads its whole batch inside one transaction, and a scrapeLogs row
 * is the heaviest thing in it. Convex rolls the transaction back on breaching
 * the read budget, so a batch that grows past half of it makes deletion fail
 * for the accounts holding the most data — the ones that most need it.
 */
test("a sweep round cannot read more than half a transaction's budget", () => {
  expect(SWEEP_BATCH).toBeGreaterThan(0);
  expect(SWEEP_BATCH * MAX_LOG_ROW_BYTES).toBeLessThanOrEqual(4_000_000);
});

test("every table carrying a userId is either swept on delete or deliberately kept", () => {
  const decided = new Set<string>([...SWEPT_ON_DELETE, ...KEPT_ON_DELETE]);
  const undecided = tablesCarryingUserId().filter((table) => !decided.has(table));
  expect(undecided).toEqual([]);
});

test("the test fixture seeds every table a deletion has to clear", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await seed(ctx as MutationCtx, LEAVING);
    expect(await remaining(ctx as MutationCtx, LEAVING)).toEqual(
      tablesCarryingUserId().sort()
    );
  });
});

test("deleting an account leaves no row carrying its userId", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await seed(ctx as MutationCtx, LEAVING);
    await deleteAllUserData(ctx as MutationCtx, LEAVING);
  });
  await t.finishAllScheduledFunctions(() => {});

  await t.run(async (ctx) => {
    expect(await remaining(ctx as MutationCtx, LEAVING)).toEqual([...KEPT_ON_DELETE].sort());
  });
});

test("the deleted account's email address and watched URL are gone with it", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await seed(ctx as MutationCtx, LEAVING);
    await deleteAllUserData(ctx as MutationCtx, LEAVING);
  });
  await t.finishAllScheduledFunctions(() => {});

  await t.run(async (ctx) => {
    const sends = await ctx.db.query("emailSends").collect();
    expect(sends.map((row) => row.to)).not.toContain(`${LEAVING}@example.com`);

    const onboarding = await ctx.db.query("onboardingEmails").collect();
    expect(onboarding.map((row) => row.email)).not.toContain(`${LEAVING}@example.com`);

    const feedback = await ctx.db.query("matchFeedback").collect();
    expect(feedback.map((row) => row.itemKey)).toEqual([]);

    const push = await ctx.db.query("pushSubscriptions").collect();
    expect(push.map((row) => row.endpoint)).toEqual([]);
  });
});

test("one account's deletion leaves every other account untouched", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await seed(ctx as MutationCtx, LEAVING);
    await seed(ctx as MutationCtx, STAYING);
    await deleteAllUserData(ctx as MutationCtx, LEAVING);
  });
  await t.finishAllScheduledFunctions(() => {});

  await t.run(async (ctx) => {
    expect(await remaining(ctx as MutationCtx, STAYING)).toEqual(tablesCarryingUserId().sort());
    const results = await ctx.db.query("scrapeResults").collect();
    expect(results).toHaveLength(1);
  });
});

test("an account holding more rows than one batch is still emptied", async () => {
  const t = convexTest(schema, modules);
  const OVER_ONE_BATCH = 250;

  await t.run(async (ctx) => {
    for (let i = 0; i < OVER_ONE_BATCH; i++) {
      await ctx.db.insert("scrapeLogs", {
        userId: LEAVING,
        url: "https://example.com/deals",
        prompt: "tell me about deals",
        status: "success",
        durationMs: 1,
        createdAt: i,
      });
      await ctx.db.insert("emailSends", {
        to: `${LEAVING}@example.com`,
        kind: "match",
        userId: LEAVING,
        status: "sent",
        createdAt: i,
        updatedAt: i,
      });
    }
    await deleteAllUserData(ctx as MutationCtx, LEAVING);
  });
  await t.finishAllScheduledFunctions(() => {});

  await t.run(async (ctx) => {
    const logs: Doc<"scrapeLogs">[] = await ctx.db.query("scrapeLogs").collect();
    const sends: Doc<"emailSends">[] = await ctx.db.query("emailSends").collect();
    expect(logs).toHaveLength(0);
    expect(sends).toHaveLength(0);
  });
});
