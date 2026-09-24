/// <reference types="vite/client" />
import { expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import {
  deleteAllUserData,
  KEPT_ON_DELETE,
  ONE_CONVEX_DOCUMENT_BYTES,
  SWEEP_BUDGET_BYTES,
  SWEEP_BUDGET_ROWS,
  SWEPT_ON_DELETE,
} from "./account";
import { internal } from "./_generated/api";
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
 * A round runs in one transaction, and Convex rolls the whole thing back on
 * breaching its read or write limits — so a round that can outgrow them means
 * deletion failing outright for the accounts holding the most data. The worst
 * a round can read is its byte budget plus the one document that crossed it.
 */
test("a round's budget leaves room for the document that overruns it", () => {
  // A read is checked after the fact, so a round reads its budget plus the one
  // document that crossed it — and Convex reads at most 8 MiB per mutation.
  expect(SWEEP_BUDGET_BYTES).toBeGreaterThan(0);
  expect(SWEEP_BUDGET_BYTES + ONE_CONVEX_DOCUMENT_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
  // Every row the allowance counts is one document deleted, and Convex writes
  // at most 8,192 per mutation.
  expect(SWEEP_BUDGET_ROWS).toBeGreaterThan(0);
  expect(SWEEP_BUDGET_ROWS).toBeLessThanOrEqual(8_192);
});

/**
 * The one thing standing between this sweep and an account that can never be
 * deleted: a round has to be able to afford the largest document Convex will
 * store. If a single row could exhaust a whole round, the round would reach
 * its limit having deleted nothing, reschedule, and meet the same row again.
 */
test("a round can always afford at least one document", () => {
  expect(SWEEP_BUDGET_BYTES).toBeGreaterThan(ONE_CONVEX_DOCUMENT_BYTES);
  expect(SWEEP_BUDGET_ROWS).toBeGreaterThan(1);
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

/**
 * Six of the eight send sites record no userId — a match alert, an error, an
 * anonymous scan and an admin bulk all write the address to `to` and leave
 * the owner blank. Sweeping by userId alone would leave most of a user's
 * email history behind, addressed to them by name.
 */
test("sends recorded without a userId go too, on the address", async () => {
  const t = convexTest(schema, modules);
  const email = `${LEAVING}@example.com`;

  await t.run(async (ctx) => {
    await ctx.db.insert("emailSends", {
      to: email,
      kind: "match",
      status: "sent",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("emailSends", {
      to: "someone.else@example.com",
      kind: "match",
      status: "sent",
      createdAt: 1,
      updatedAt: 1,
    });
    await deleteAllUserData(ctx as MutationCtx, LEAVING, email);
  });
  await t.finishAllScheduledFunctions(() => {});

  await t.run(async (ctx) => {
    const sends = await ctx.db.query("emailSends").collect();
    expect(sends.map((row) => row.to)).toEqual(["someone.else@example.com"]);
  });
});

/**
 * The sweep finds sends on an exact index match, so the address it looks for
 * and the address that was stored have to agree on case. Some send sites
 * lowercase and some pass identity.email through untouched, so the agreement
 * has to be made rather than hoped for — at the one mutation every send goes
 * through, and at the sweep.
 */
test("a send recorded in mixed case still goes", async () => {
  const t = convexTest(schema, modules);

  await t.mutation(internal.emailEvents.recordSend, {
    to: "User.Leaving@Example.COM",
    kind: "match",
    ok: true,
  });

  await t.run(async (ctx) => {
    const [stored] = await ctx.db.query("emailSends").collect();
    expect(stored.to).toBe("user.leaving@example.com");
    await deleteAllUserData(ctx as MutationCtx, LEAVING, "USER.LEAVING@example.com");
  });
  await t.finishAllScheduledFunctions(() => {});

  await t.run(async (ctx) => {
    expect(await ctx.db.query("emailSends").collect()).toHaveLength(0);
  });
});

/**
 * Characters are not bytes. A CJK character is one UTF-16 code unit and three
 * UTF-8 bytes, so measuring a row by string length undercounts it threefold —
 * and scraped page text is exactly where non-ASCII lives. The budget has to
 * hold against the text the scraper actually brings back.
 */
test("the byte budget holds when rows are multi-byte", async () => {
  const t = convexTest(schema, modules);
  // 100k CJK characters: 100k UTF-16 units, 300k UTF-8 bytes.
  const FILLER = "検".repeat(100_000);
  const ROW_BYTES = new TextEncoder().encode(FILLER).length;
  const ROWS = 60;

  await t.run(async (ctx) => {
    const monitorId = await ctx.db.insert("monitors", {
      userId: LEAVING,
      name: "watch",
      url: "https://example.com/deals",
      prompt: "tell me about deals",
      status: "active",
      checkInterval: "1h",
      matchCount: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    for (let i = 0; i < ROWS; i++) {
      await ctx.db.insert("scrapeResults", {
        monitorId,
        matches: [FILLER],
        totalItems: 0,
        hasNewMatches: false,
        scrapedAt: i,
      });
    }
    await deleteAllUserData(ctx as MutationCtx, LEAVING);
  });

  await t.run(async (ctx) => {
    const deleted = ROWS - (await ctx.db.query("scrapeResults").collect()).length;
    expect(deleted).toBeGreaterThan(0);
    expect(deleted * ROW_BYTES).toBeLessThanOrEqual(
      SWEEP_BUDGET_BYTES + ONE_CONVEX_DOCUMENT_BYTES
    );
  });
});

/**
 * An anonymous scan writes its logs under an `anon_` id, and claiming the
 * monitor at signup re-keys the monitor alone. The logs keep the anon id, so
 * a sweep by userId walks straight past them — leaving the URL, the prompt
 * and the raw AI response of every check the scan ever ran.
 */
test("logs from a monitor's anonymous life go when the account does", async () => {
  const t = convexTest(schema, modules);
  const ANON = "anon_11111111-2222-3333-4444-555555555555";

  await t.run(async (ctx) => {
    const monitorId = await ctx.db.insert("monitors", {
      userId: ANON,
      name: "watch",
      url: "https://example.com/deals",
      prompt: "tell me about deals",
      status: "active",
      checkInterval: "24h",
      matchCount: 0,
      isAnonymous: true,
      createdAt: 1,
      updatedAt: 1,
    });
    // Two checks while anonymous, then one after the claim.
    for (const userId of [ANON, ANON, LEAVING]) {
      await ctx.db.insert("scrapeLogs", {
        userId,
        monitorId,
        url: "https://example.com/deals",
        prompt: "tell me about deals",
        status: "success",
        durationMs: 1,
        createdAt: 1,
      });
    }
    // What anonymous.claim does: the monitor is re-keyed, the logs are not.
    await ctx.db.patch(monitorId, { userId: LEAVING, isAnonymous: undefined });

    await deleteAllUserData(ctx as MutationCtx, LEAVING);
  });
  await t.finishAllScheduledFunctions(() => {});

  await t.run(async (ctx) => {
    expect(await ctx.db.query("scrapeLogs").collect()).toHaveLength(0);
  });
});

/**
 * `schema: v.any()` accepts every Convex value, Int64 and Bytes included, and
 * JSON cannot serialise either. Weighing a row by serialising it would throw
 * on the first such document and take the whole account deletion with it —
 * the one row nobody can work around, because the owner cannot edit it.
 */
test("a document holding a bigint does not break the sweep", async () => {
  const t = convexTest(schema, modules);

  await t.run(async (ctx) => {
    await ctx.db.insert("monitors", {
      userId: LEAVING,
      name: "watch",
      url: "https://example.com/deals",
      prompt: "tell me about deals",
      status: "active",
      checkInterval: "1h",
      matchCount: 0,
      schema: { seen: 12n, blob: new ArrayBuffer(64) },
      createdAt: 1,
      updatedAt: 1,
    });
    await deleteAllUserData(ctx as MutationCtx, LEAVING);
  });
  await t.finishAllScheduledFunctions(() => {});

  await t.run(async (ctx) => {
    expect(await ctx.db.query("monitors").collect()).toHaveLength(0);
  });
});

/**
 * A monitor carries `schema: v.any()` and three arrays with no size limit, so
 * an account of fat monitors and no children can outrun the budget while the
 * row counter barely moves.
 */
test("the monitors themselves are charged to the byte budget", async () => {
  const t = convexTest(schema, modules);
  const FILLER = "x".repeat(400_000);
  const MONITORS = 30;

  await t.run(async (ctx) => {
    for (let i = 0; i < MONITORS; i++) {
      await ctx.db.insert("monitors", {
        userId: LEAVING,
        name: "watch",
        url: "https://example.com/deals",
        prompt: "tell me about deals",
        status: "active",
        checkInterval: "1h",
        matchCount: 0,
        blacklistedItems: [FILLER],
        createdAt: 1,
        updatedAt: 1,
      });
    }
    await deleteAllUserData(ctx as MutationCtx, LEAVING);
  });

  await t.run(async (ctx) => {
    const deleted = MONITORS - (await ctx.db.query("monitors").collect()).length;
    expect(deleted).toBeGreaterThan(0);
    expect(deleted * FILLER.length).toBeLessThanOrEqual(
      SWEEP_BUDGET_BYTES + ONE_CONVEX_DOCUMENT_BYTES
    );
  });
});

/**
 * The budget is checked after a read, so a round overruns it by whatever
 * crossed the line — and that has to be one document, not two. A monitor
 * whose own weight breaks the budget must be the last thing the round reads:
 * going on to read one of its children would put the round a second full
 * document over, and the ceiling asserted above would be a fiction.
 */
test("a monitor that breaks the budget is the last row its round reads", async () => {
  const t = convexTest(schema, modules);
  const FAT = "x".repeat(990_000);
  const monitor = (extra: object) => ({
    userId: LEAVING,
    name: "watch",
    url: "https://example.com/deals",
    prompt: "tell me about deals",
    status: "active" as const,
    checkInterval: "1h" as const,
    matchCount: 0,
    blacklistedItems: [FAT],
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  });

  await t.run(async (ctx) => {
    // Four monitors bring the round to the edge of its budget; the fifth
    // crosses it on its own weight, before any child is looked at.
    for (let i = 0; i < 4; i++) await ctx.db.insert("monitors", monitor({}));
    const last = await ctx.db.insert("monitors", monitor({}));
    await ctx.db.insert("scrapeResults", {
      monitorId: last,
      matches: [FAT],
      totalItems: 0,
      hasNewMatches: false,
      scrapedAt: 1,
    });

    await deleteAllUserData(ctx as MutationCtx, LEAVING);
  });

  // Before any scheduled round runs: the fifth monitor's child is untouched,
  // so the round read five monitors and stopped, not five and a result.
  await t.run(async (ctx) => {
    expect(await ctx.db.query("scrapeResults").collect()).toHaveLength(1);
    const readBytes = 5 * FAT.length;
    expect(readBytes).toBeLessThanOrEqual(SWEEP_BUDGET_BYTES + ONE_CONVEX_DOCUMENT_BYTES);
  });

  await t.finishAllScheduledFunctions(() => {});
  await t.run(async (ctx) => {
    expect(await ctx.db.query("monitors").collect()).toHaveLength(0);
    expect(await ctx.db.query("scrapeResults").collect()).toHaveLength(0);
  });
});

/**
 * A scrape result is the heaviest row an account owns and nothing prunes the
 * table, so collecting every one of them in a single transaction breaks the
 * read budget for exactly the accounts this sweep exists to rescue.
 */
test("a monitor with more results than one round can read is still deleted", async () => {
  const t = convexTest(schema, modules);
  const RESULTS = SWEEP_BUDGET_ROWS * 2 + 5;

  await t.run(async (ctx) => {
    const monitorId = await ctx.db.insert("monitors", {
      userId: LEAVING,
      name: "watch",
      url: "https://example.com/deals",
      prompt: "tell me about deals",
      status: "active",
      checkInterval: "1h",
      matchCount: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    for (let i = 0; i < RESULTS; i++) {
      await ctx.db.insert("scrapeResults", {
        monitorId,
        matches: [],
        totalItems: 0,
        hasNewMatches: false,
        scrapedAt: i,
      });
    }
    await deleteAllUserData(ctx as MutationCtx, LEAVING);
  });
  await t.finishAllScheduledFunctions(() => {});

  await t.run(async (ctx) => {
    expect(await ctx.db.query("scrapeResults").collect()).toHaveLength(0);
    expect(await ctx.db.query("monitors").collect()).toHaveLength(0);
  });
});

/**
 * The budget has to hold against row sizes nothing caps. A scrapeResults row
 * has no ceiling at all — one fat row must not be able to carry a round past
 * what the transaction can read.
 */
test("a round stops once it has spent its byte budget", async () => {
  const t = convexTest(schema, modules);
  const FILLER = "x".repeat(200_000);
  const ROWS = 60;

  await t.run(async (ctx) => {
    const monitorId = await ctx.db.insert("monitors", {
      userId: LEAVING,
      name: "watch",
      url: "https://example.com/deals",
      prompt: "tell me about deals",
      status: "active",
      checkInterval: "1h",
      matchCount: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    for (let i = 0; i < ROWS; i++) {
      await ctx.db.insert("scrapeResults", {
        monitorId,
        matches: [FILLER],
        totalItems: 0,
        hasNewMatches: false,
        scrapedAt: i,
      });
    }
    await deleteAllUserData(ctx as MutationCtx, LEAVING);
  });

  // No scheduled rounds run yet, so this is what one round alone managed.
  await t.run(async (ctx) => {
    const left = await ctx.db.query("scrapeResults").collect();
    const deleted = ROWS - left.length;
    expect(deleted).toBeGreaterThan(0);
    expect(deleted * FILLER.length).toBeLessThanOrEqual(
      SWEEP_BUDGET_BYTES + ONE_CONVEX_DOCUMENT_BYTES
    );
  });

  await t.finishAllScheduledFunctions(() => {});
  await t.run(async (ctx) => {
    expect(await ctx.db.query("scrapeResults").collect()).toHaveLength(0);
  });
});

test("an account holding more rows than one batch is still emptied", async () => {
  const t = convexTest(schema, modules);
  const OVER_ONE_BATCH = SWEEP_BUDGET_ROWS + 10;

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
