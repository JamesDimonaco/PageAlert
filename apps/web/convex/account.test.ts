/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { WithoutSystemFields } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "./schema";
import {
  deleteAllUserData,
  deleteAuthIdentity,
  KEPT_ON_DELETE,
  ONE_CONVEX_DOCUMENT_BYTES,
  SWEEP_BUDGET_BYTES,
  SWEEP_BUDGET_ROWS,
  SWEPT_ON_DELETE,
} from "./account";
import { api, components, internal } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

const NOW = 1_700_000_000_000;
const LEAVING = "user-leaving";
const STAYING = "user-staying";

// The erasure audit is scheduled ten minutes out, so every test that runs a
// deletion has to be able to jump the clock past it.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type AnyTest = ReturnType<typeof convexTest>;

/** Runs every scheduled function, however far out it was queued. */
async function settle(t: AnyTest): Promise<void> {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

/** How many times the admin was alerted, whatever became of the alert. */
async function adminAlerts(t: AnyTest, saying = ""): Promise<number> {
  return t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter((job) => {
      if (job.name !== "admin:notify") return false;
      const [args] = job.args as [{ text: string }];
      return args.text.includes(saying);
    }).length;
  });
}

/** A test harness that can also reach the Better Auth component's tables. */
function withAuth() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

/**
 * A signed-up identity: the user row, one live session, one linked provider
 * account. Returns the user id, which is what `identity.subject` carries.
 */
async function seedIdentity(t: AnyTest, email: string): Promise<string> {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: { name: "A Person", email, emailVerified: true, createdAt: NOW, updatedAt: NOW },
    },
  })) as { _id: string };

  await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        token: `tok_${email}`,
        expiresAt: NOW + 86_400_000,
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  });
  await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "account",
      data: {
        userId: user._id,
        accountId: `google_${email}`,
        providerId: "google",
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  });

  return user._id;
}

/** Which of this identity's auth rows are still there. */
async function authRowsLeft(t: AnyTest, userId: string) {
  const one = async (model: "user" | "session" | "account", field: string, value: string) =>
    (await t.query(components.betterAuth.adapter.findOne, {
      model,
      where: [{ field, operator: "eq", value }],
    })) !== null;

  return {
    user: await one("user", "_id", userId),
    session: await one("session", "userId", userId),
    account: await one("account", "userId", userId),
  };
}

type Row<T extends TableNames> = WithoutSystemFields<Doc<T>>;
type Refs = { userId: string; monitorId: Id<"monitors"> };

function monitorRow(userId: string, extra: Partial<Row<"monitors">> = {}): Row<"monitors"> {
  return {
    userId,
    userEmail: `${userId}@example.test`,
    name: "Laptops",
    url: "https://shop.test/laptops",
    prompt: "MacBook under £1000",
    status: "active",
    checkInterval: "1h",
    matchCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

function resultRow(monitorId: Id<"monitors">, extra: Partial<Row<"scrapeResults">> = {}): Row<"scrapeResults"> {
  return { monitorId, matches: [], totalItems: 0, hasNewMatches: false, scrapedAt: NOW, ...extra };
}

function logRow(userId: string, extra: Partial<Row<"scrapeLogs">> = {}): Row<"scrapeLogs"> {
  return {
    userId,
    url: "https://shop.test/laptops",
    prompt: "MacBook under £1000",
    status: "success",
    durationMs: 1,
    createdAt: NOW,
    ...extra,
  };
}

/**
 * One row per table, belonging to `userId`. The mapped type means a table
 * added to the schema does not compile until it has a fixture here and a
 * verdict in KEPT or in the sweep. That is the point: "delete everything" is
 * a promise in the privacy policy, and the last two tables added to the
 * schema were both missed.
 */
const FIXTURES: { [T in TableNames]: (refs: Refs) => Row<T> } = {
  monitors: ({ userId }) => monitorRow(userId),
  scrapeResults: ({ monitorId }) => resultRow(monitorId),
  notifications: ({ userId, monitorId }) => ({
    userId,
    monitorId,
    channel: "email",
    title: "Match",
    message: "Found one",
    sentAt: NOW,
    read: false,
  }),
  scrapeLogs: ({ userId, monitorId }) => logRow(userId, { monitorId }),
  matchFeedback: ({ userId, monitorId }) => ({
    userId,
    monitorId,
    itemKey: "https://shop.test/mbp",
    itemTitle: "MacBook Pro",
    verdict: "good",
    prompt: "MacBook under £1000",
    source: "dashboard",
    createdAt: NOW,
  }),
  notificationSettings: ({ userId }) => ({
    userId,
    channel: "telegram",
    enabled: true,
    target: `chat-${userId}`,
  }),
  userTiers: ({ userId }) => ({ userId, tier: "free", updatedAt: NOW }),
  pushSubscriptions: ({ userId }) => ({
    userId,
    endpoint: `https://push.test/${userId}`,
    p256dh: "key",
    auth: "auth",
    createdAt: NOW,
  }),
  appliedOrders: ({ userId }) => ({ orderId: `order-${userId}`, userId, appliedAt: NOW }),
  bannedUsers: ({ userId }) => ({
    userId,
    email: `${userId}@example.test`,
    bannedBy: "admin@example.test",
    bannedAt: NOW,
  }),
  channelClaims: ({ userId }) => ({
    channel: "telegram",
    target: `chat-${userId}`,
    userId,
    claimedAt: NOW,
  }),
  reviews: ({ userId }) => ({ userId, displayName: "Sam", quote: "Handy", createdAt: NOW }),
  anonymousScanCounter: () => ({ date: "2026-09-23", count: 1 }),
  userActivity: ({ userId }) => ({ userId, lastSeenAt: NOW }),
  counters: ({ userId }) => ({ name: `counter-${userId}`, value: 1 }),
  monitorCreations: ({ userId }) => ({ userId, createdAt: NOW }),
  emailSends: ({ userId }) => ({
    to: `${userId}@example.test`,
    kind: "match",
    userId,
    status: "sent",
    createdAt: NOW,
    updatedAt: NOW,
  }),
  adminEmails: ({ userId }) => ({
    sentBy: "admin@example.test",
    subject: "Hello",
    body: "Hi",
    recipients: [`${userId}@example.test`],
    failedRecipients: [],
    sentAt: NOW,
  }),
  phoneVerifications: ({ userId }) => ({
    userId,
    phone: "+447911123456",
    code: "481920",
    expiresAt: NOW + 600_000,
    attempts: 0,
  }),
  onboardingEmails: ({ userId }) => ({
    userId,
    email: `${userId}@example.test`,
    step: "day0",
    scheduledFor: NOW,
    status: "pending",
  }),
};

/** Tables deleteAllUserData leaves alone, each with the reason it is allowed to. */
const KEPT: Partial<Record<TableNames, string>> = {
  bannedUsers: "a ban has to outlive the account it was placed on",
  appliedOrders:
    "opaque Polar order ids; Polar redelivers webhooks for up to a day, and this is what stops a redelivery re-granting the tier",
  adminEmails: "the operator's record of what was sent and to whom",
  counters: "aggregate, holds no personal data",
  anonymousScanCounter: "aggregate, holds no personal data",
};

const TABLES = Object.keys(schema.tables) as TableNames[];

/**
 * Every table whose rows carry a userId, read off the schema rather than
 * listed here. A new table with a userId lands in this set the moment it is
 * defined, so the completeness test below fails until somebody decides
 * whether deletion should take it.
 */
function tablesCarryingUserId(): TableNames[] {
  const tables = schema.tables as unknown as Record<
    string,
    { validator: { fields: Record<string, unknown> } }
  >;
  return TABLES.filter((name) => "userId" in tables[name].validator.fields);
}

/** One row in every table for `userId`, keyed by table so a test can ask after each. */
async function insertRowsFor(
  ctx: MutationCtx,
  userId: string
): Promise<Record<TableNames, Id<TableNames>>> {
  const monitorId = await ctx.db.insert("monitors", monitorRow(userId));
  const ids = { monitors: monitorId } as Record<TableNames, Id<TableNames>>;
  for (const table of TABLES) {
    if (table === "monitors") continue;
    ids[table] = await ctx.db.insert(table, FIXTURES[table]({ userId, monitorId }));
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Which tables
// ---------------------------------------------------------------------------

test("the fixture has a verdict for every table in the schema", () => {
  // The mapped type catches this at compile time; vitest does not type-check,
  // so the same claim is asserted at runtime.
  expect(Object.keys(FIXTURES).sort()).toEqual([...TABLES].sort());
});

test("every table carrying a userId is either swept on delete or deliberately kept", () => {
  const decided = new Set<string>([...SWEPT_ON_DELETE, ...KEPT_ON_DELETE]);
  const undecided = tablesCarryingUserId().filter((table) => !decided.has(table));
  expect(undecided).toEqual([]);

  // The code's keep-list and this file's are the same list, so neither can
  // quietly grow a table the other still expects to be erased.
  const keptWithUserId = tablesCarryingUserId().filter((table) => table in KEPT);
  expect(keptWithUserId.sort()).toEqual([...KEPT_ON_DELETE].sort());
});

test("deletion removes the user's rows from every table not deliberately kept, and nobody else's", async () => {
  const t = convexTest(schema, modules);

  const { mine, theirs } = await t.run(async (ctx) => ({
    mine: await insertRowsFor(ctx, LEAVING),
    theirs: await insertRowsFor(ctx, STAYING),
  }));

  await t.run((ctx) => deleteAllUserData(ctx, LEAVING, `${LEAVING}@example.test`));
  await settle(t);

  await t.run(async (ctx) => {
    for (const table of TABLES) {
      const survivor = await ctx.db.get(mine[table]);
      if (table in KEPT) {
        expect(survivor, `${table} is listed as kept but was deleted`).not.toBeNull();
      } else {
        expect(survivor, `${table} row survived account deletion`).toBeNull();
      }
      expect(await ctx.db.get(theirs[table]), `${table} row of another user was deleted`).not.toBeNull();
    }
  });
});

test("the deleted account's email address and watched URL are gone with it", async () => {
  const t = convexTest(schema, modules);
  const email = `${LEAVING}@example.test`;

  await t.run(async (ctx) => {
    await insertRowsFor(ctx, LEAVING);
    await deleteAllUserData(ctx, LEAVING, email);
  });
  await settle(t);

  await t.run(async (ctx) => {
    const sends = await ctx.db.query("emailSends").collect();
    expect(sends.map((row) => row.to)).not.toContain(email);

    const onboarding = await ctx.db.query("onboardingEmails").collect();
    expect(onboarding.map((row) => row.email)).not.toContain(email);

    const monitors = await ctx.db.query("monitors").collect();
    expect(monitors.map((row) => row.url)).toEqual([]);

    const feedback = await ctx.db.query("matchFeedback").collect();
    expect(feedback.map((row) => row.itemKey)).toEqual([]);

    const push = await ctx.db.query("pushSubscriptions").collect();
    expect(push.map((row) => row.endpoint)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Email records
// ---------------------------------------------------------------------------

/**
 * The fixture above tags its emailSends row with a userId, which only the
 * onboarding and inactivity emails actually do. Match, error,
 * monitor-stopped, price, anonymous-scan and bulk all record with userId
 * undefined, so a by_userId sweep leaves a year of alerts behind with the
 * address still in `to` — and the privacy policy promises otherwise.
 */
test("email records that were never tagged with a userId go too, on the address", async () => {
  const t = convexTest(schema, modules);
  const email = `${LEAVING}@example.test`;

  const { untagged, otherPerson } = await t.run(async (ctx) => ({
    untagged: await ctx.db.insert("emailSends", {
      to: email,
      kind: "match",
      status: "sent",
      createdAt: NOW,
      updatedAt: NOW,
    }),
    otherPerson: await ctx.db.insert("emailSends", {
      to: "someone-else@example.test",
      kind: "match",
      status: "sent",
      createdAt: NOW,
      updatedAt: NOW,
    }),
  }));

  await t.run((ctx) => deleteAllUserData(ctx, LEAVING, email));
  await settle(t);

  await t.run(async (ctx) => {
    expect(await ctx.db.get(untagged), "an untagged send to this address survived").toBeNull();
    expect(await ctx.db.get(otherPerson), "another person's send was deleted").not.toBeNull();
  });
});

/**
 * The sweep finds sends on an exact index match, so the address it looks for
 * and the address that was stored have to agree on case. Some send sites
 * lowercase and some pass identity.email through untouched, so the agreement
 * has to be made rather than hoped for — at the mutations every send goes
 * through, and at the sweep.
 */
test("a send recorded in mixed case still goes", async () => {
  const t = convexTest(schema, modules);

  await t.mutation(internal.emailEvents.recordSend, {
    to: "User.Leaving@Example.TEST",
    kind: "match",
    ok: true,
  });

  await t.run(async (ctx) => {
    const [stored] = await ctx.db.query("emailSends").collect();
    expect(stored.to).toBe("user.leaving@example.test");
    await deleteAllUserData(ctx, LEAVING, "USER.LEAVING@example.test");
  });
  await settle(t);

  await t.run(async (ctx) => {
    expect(await ctx.db.query("emailSends").collect()).toHaveLength(0);
  });
});

/** The bulk sender records its recipients through a second mutation, which has to agree too. */
test("a bulk send recorded in mixed case still goes", async () => {
  const t = convexTest(schema, modules);

  await t.mutation(internal.emailEvents.recordSends, {
    kind: "bulk",
    sends: [{ to: "User.Leaving@Example.TEST" }, { to: "Someone.Else@Example.TEST" }],
    ok: true,
  });

  await t.run(async (ctx) => {
    const stored = await ctx.db.query("emailSends").collect();
    expect(stored.map((row) => row.to).sort()).toEqual([
      "someone.else@example.test",
      "user.leaving@example.test",
    ]);
    await deleteAllUserData(ctx, LEAVING, "USER.LEAVING@example.test");
  });
  await settle(t);

  await t.run(async (ctx) => {
    const left = await ctx.db.query("emailSends").collect();
    expect(left.map((row) => row.to)).toEqual(["someone.else@example.test"]);
  });
});

// ---------------------------------------------------------------------------
// Heavy accounts
// ---------------------------------------------------------------------------

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
    const monitorId = await ctx.db.insert("monitors", monitorRow(LEAVING));
    for (let i = 0; i < ROWS; i++) {
      await ctx.db.insert("scrapeResults", resultRow(monitorId, { matches: [FILLER], scrapedAt: i }));
    }
    await deleteAllUserData(ctx, LEAVING, undefined);
  });

  // No scheduled round has run yet, so this is what one round alone managed.
  await t.run(async (ctx) => {
    const deleted = ROWS - (await ctx.db.query("scrapeResults").collect()).length;
    expect(deleted).toBeGreaterThan(0);
    expect(deleted * ROW_BYTES).toBeLessThanOrEqual(SWEEP_BUDGET_BYTES + ONE_CONVEX_DOCUMENT_BYTES);
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
    const monitorId = await ctx.db.insert(
      "monitors",
      monitorRow(ANON, { checkInterval: "24h", isAnonymous: true })
    );
    // Two checks while anonymous, then one after the claim.
    for (const userId of [ANON, ANON, LEAVING]) {
      await ctx.db.insert("scrapeLogs", logRow(userId, { monitorId }));
    }
    // What anonymous.claim does: the monitor is re-keyed, the logs are not.
    await ctx.db.patch(monitorId, { userId: LEAVING, isAnonymous: undefined });

    await deleteAllUserData(ctx, LEAVING, undefined);
  });
  await settle(t);

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
    await ctx.db.insert(
      "monitors",
      monitorRow(LEAVING, { schema: { seen: 12n, blob: new ArrayBuffer(64) } })
    );
    await deleteAllUserData(ctx, LEAVING, undefined);
  });
  await settle(t);

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
      await ctx.db.insert("monitors", monitorRow(LEAVING, { blacklistedItems: [FILLER] }));
    }
    await deleteAllUserData(ctx, LEAVING, undefined);
  });

  await t.run(async (ctx) => {
    const deleted = MONITORS - (await ctx.db.query("monitors").collect()).length;
    expect(deleted).toBeGreaterThan(0);
    expect(deleted * FILLER.length).toBeLessThanOrEqual(SWEEP_BUDGET_BYTES + ONE_CONVEX_DOCUMENT_BYTES);
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

  await t.run(async (ctx) => {
    // Four monitors bring the round to the edge of its budget; the fifth
    // crosses it on its own weight, before any child is looked at.
    for (let i = 0; i < 4; i++) {
      await ctx.db.insert("monitors", monitorRow(LEAVING, { blacklistedItems: [FAT] }));
    }
    const last = await ctx.db.insert("monitors", monitorRow(LEAVING, { blacklistedItems: [FAT] }));
    await ctx.db.insert("scrapeResults", resultRow(last, { matches: [FAT] }));

    await deleteAllUserData(ctx, LEAVING, undefined);
  });

  // Before any scheduled round runs: the fifth monitor's child is untouched,
  // so the round read five monitors and stopped, not five and a result.
  await t.run(async (ctx) => {
    expect(await ctx.db.query("scrapeResults").collect()).toHaveLength(1);
    const readBytes = 5 * FAT.length;
    expect(readBytes).toBeLessThanOrEqual(SWEEP_BUDGET_BYTES + ONE_CONVEX_DOCUMENT_BYTES);
  });

  await settle(t);
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
    const monitorId = await ctx.db.insert("monitors", monitorRow(LEAVING));
    for (let i = 0; i < RESULTS; i++) {
      await ctx.db.insert("scrapeResults", resultRow(monitorId, { scrapedAt: i }));
    }
    await deleteAllUserData(ctx, LEAVING, undefined);
  });
  await settle(t);

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
    const monitorId = await ctx.db.insert("monitors", monitorRow(LEAVING));
    for (let i = 0; i < ROWS; i++) {
      await ctx.db.insert("scrapeResults", resultRow(monitorId, { matches: [FILLER], scrapedAt: i }));
    }
    await deleteAllUserData(ctx, LEAVING, undefined);
  });

  // No scheduled rounds run yet, so this is what one round alone managed.
  await t.run(async (ctx) => {
    const left = await ctx.db.query("scrapeResults").collect();
    const deleted = ROWS - left.length;
    expect(deleted).toBeGreaterThan(0);
    expect(deleted * FILLER.length).toBeLessThanOrEqual(SWEEP_BUDGET_BYTES + ONE_CONVEX_DOCUMENT_BYTES);
  });

  await settle(t);
  await t.run(async (ctx) => {
    expect(await ctx.db.query("scrapeResults").collect()).toHaveLength(0);
  });
});

test("an account holding more rows than one batch is still emptied", async () => {
  const t = convexTest(schema, modules);
  const OVER_ONE_BATCH = SWEEP_BUDGET_ROWS + 10;

  await t.run(async (ctx) => {
    for (let i = 0; i < OVER_ONE_BATCH; i++) {
      await ctx.db.insert("scrapeLogs", logRow(LEAVING, { createdAt: i }));
      await ctx.db.insert("emailSends", {
        to: `${LEAVING}@example.test`,
        kind: "match",
        userId: LEAVING,
        status: "sent",
        createdAt: i,
        updatedAt: i,
      });
    }
    await deleteAllUserData(ctx, LEAVING, undefined);
  });
  await settle(t);

  await t.run(async (ctx) => {
    expect(await ctx.db.query("scrapeLogs").collect()).toHaveLength(0);
    expect(await ctx.db.query("emailSends").collect()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------

/**
 * Past the first round the sweep is a chain of scheduled mutations, and a
 * chain only continues from inside a run that succeeded: one throw ends it
 * silently with half a user's data still on disk, and nothing else would
 * ever notice. The audit is what notices.
 */
test("the audit alerts the admin when a deleted account's rows are still there", async () => {
  const leftovers: { name: string; insert: (ctx: MutationCtx) => Promise<unknown> }[] = [
    { name: "a check log", insert: (ctx) => ctx.db.insert("scrapeLogs", logRow(LEAVING)) },
    { name: "a monitor", insert: (ctx) => ctx.db.insert("monitors", monitorRow(LEAVING)) },
    {
      name: "an untagged send, stored lowercase",
      insert: (ctx) =>
        ctx.db.insert("emailSends", {
          to: `${LEAVING}@example.test`,
          kind: "match",
          status: "sent",
          createdAt: NOW,
          updatedAt: NOW,
        }),
    },
  ];

  for (const leftover of leftovers) {
    const t = convexTest(schema, modules);
    await t.run((ctx) => leftover.insert(ctx));

    await t.mutation(internal.account.auditErasure, {
      userId: LEAVING,
      email: `${LEAVING.toUpperCase()}@Example.TEST`,
    });

    expect(await adminAlerts(t), `${leftover.name} survived and nobody was told`).toBe(1);
  }
});

test("the audit is queued by the deletion and stays silent when nothing is left", async () => {
  const t = convexTest(schema, modules);

  await t.run(async (ctx) => {
    await insertRowsFor(ctx, LEAVING);
    await deleteAllUserData(ctx, LEAVING, `${LEAVING}@example.test`);
  });

  const audits = await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter((job) => job.name === "account:auditErasure");
  });
  expect(audits).toHaveLength(1);
  // Long after the heaviest account's chain would be done, so a survivor means
  // the chain stopped early rather than that it is still going.
  expect(audits[0].scheduledTime - Date.now()).toBe(10 * 60 * 1000);

  await settle(t);
  expect(await adminAlerts(t)).toBe(0);
});

// ---------------------------------------------------------------------------
// The identity
// ---------------------------------------------------------------------------

/**
 * "Permanently delete your account" has to mean the account, not only its
 * contents. Until now the sweep cleared every app table and left the Better
 * Auth identity — name, email, image, and the linked provider account —
 * sitting behind it, with the same userId re-attaching on the next sign-in.
 */
test("deleting an account destroys the identity behind it", async () => {
  const t = withAuth();
  const email = "leaving@example.test";
  const userId = await seedIdentity(t, email);

  await t.run(async (ctx) => {
    const ids = await insertRowsFor(ctx, userId);
    // The fixture bans everyone it seeds. This person is not banned; that
    // case is the test below.
    await ctx.db.delete(ids.bannedUsers);
  });

  await t.withIdentity({ subject: userId, email }).mutation(api.account.deleteAccount, {});
  await settle(t);

  expect(await authRowsLeft(t, userId)).toEqual({ user: false, session: false, account: false });
  await t.run(async (ctx) => {
    expect(await ctx.db.query("monitors").collect()).toHaveLength(0);
  });
});

/**
 * Every ban is enforced by userId, so destroying the identity would hand a
 * banned person a clean one: delete, sign up again, new userId, no ban. And a
 * half-measure that erased the data but kept the identity would leave the
 * app in a state nothing else expects. So the self-service path refuses
 * outright and points at the contact address; erasure for a banned account
 * is the admin's forced delete, which drops the ban with the identity.
 */
test("a banned account is refused, and nothing of it is deleted", async () => {
  const t = withAuth();
  const email = "banned@example.test";
  const userId = await seedIdentity(t, email);

  // The fixture already writes the ban row this test turns on.
  const ids = await t.run((ctx) => insertRowsFor(ctx, userId));

  await expect(
    t.withIdentity({ subject: userId, email }).mutation(api.account.deleteAccount, {})
  ).rejects.toThrow(/suspended/i);
  await settle(t);

  expect(await authRowsLeft(t, userId)).toEqual({ user: true, session: true, account: true });
  await t.run(async (ctx) => {
    for (const table of TABLES) {
      expect(await ctx.db.get(ids[table]), `${table} row was deleted for a banned account`).not.toBeNull();
    }
  });
  expect(await adminAlerts(t)).toBe(0);
});

test("one account's deletion leaves another's identity alone", async () => {
  const t = withAuth();
  const leaving = await seedIdentity(t, "leaving@example.test");
  const staying = await seedIdentity(t, "staying@example.test");

  await t
    .withIdentity({ subject: leaving, email: "leaving@example.test" })
    .mutation(api.account.deleteAccount, {});
  await settle(t);

  expect(await authRowsLeft(t, staying)).toEqual({ user: true, session: true, account: true });
});

/**
 * The admin's forced delete already removed the auth rows, by its own copy of
 * this logic. Both paths go through one helper now, so neither can drift from
 * the other's idea of what deleting an account means.
 */
test("the shared helper clears sessions, provider accounts and the user", async () => {
  const t = withAuth();
  const userId = await seedIdentity(t, "forced@example.test");

  await t.run((ctx) => deleteAuthIdentity(ctx, userId));

  expect(await authRowsLeft(t, userId)).toEqual({ user: false, session: false, account: false });
});

// ---------------------------------------------------------------------------
// The token that outlives the account
// ---------------------------------------------------------------------------

/**
 * Deleting the sessions does not cut off access: Convex verifies a JWT against
 * the JWKS endpoint rather than reading the session table, and those tokens
 * live 15 minutes. So a token already in hand still works after the account
 * behind it is gone — and every mutation trusts `identity.subject` without
 * asking whether that user exists.
 *
 * Two of them write new personal data under the dead id. A monitor created
 * this way is unreachable forever: its owner has no account to sign in with,
 * so nobody can pause or delete it while it scans and emails on. And a
 * notification setting brings the deleted address back into the database,
 * which is the one thing this whole change exists to prevent.
 */
test("a deleted account cannot create a monitor with its leftover token", async () => {
  const t = withAuth();
  const email = "ghost@example.test";
  const userId = await seedIdentity(t, email);
  const as = t.withIdentity({ subject: userId, email });

  await as.mutation(api.account.deleteAccount, {});
  await settle(t);

  await expect(
    as.mutation(api.monitors.create, {
      name: "after the grave",
      url: "https://shop.test/laptops",
      prompt: "MacBook under £1000",
      checkInterval: "1h",
    })
  ).rejects.toThrow(/no longer exists/i);

  await t.run(async (ctx) => {
    expect(await ctx.db.query("monitors").collect()).toHaveLength(0);
  });
});

test("a deleted account cannot put its email address back", async () => {
  const t = withAuth();
  const email = "ghost@example.test";
  const userId = await seedIdentity(t, email);
  const as = t.withIdentity({ subject: userId, email });

  await as.mutation(api.account.deleteAccount, {});
  await settle(t);

  await expect(
    as.mutation(api.notificationSettings.upsert, { channel: "email", enabled: true, target: email })
  ).rejects.toThrow(/no longer exists/i);

  await t.run(async (ctx) => {
    expect(await ctx.db.query("notificationSettings").collect()).toHaveLength(0);
  });
});

/**
 * The guard must not cost anybody their first monitor. A signed-in user whose
 * identity is intact has to pass it, whether or not they have ever created
 * anything before.
 */
test("a live account is not blocked by the guard", async () => {
  const t = withAuth();
  const email = "alive@example.test";
  const userId = await seedIdentity(t, email);

  const id = await t.withIdentity({ subject: userId, email }).mutation(api.monitors.create, {
    name: "first one",
    url: "https://shop.test/laptops",
    prompt: "MacBook under £1000",
    checkInterval: "1h",
  });

  expect(id).toBeTruthy();
});

/**
 * The writers that fire on their own. The dashboard layout calls
 * claimMyAnonymousMonitors and touchLastSeen on every load, so a dead
 * session's token reaches them without anybody clicking anything. Each has
 * to write nothing, and quietly: the layout retries a claim that throws on
 * every render, so a throw here would be a console full of errors for the
 * rest of the token's life.
 */
test("a deleted account's leftover token cannot claim an anonymous monitor", async () => {
  const t = withAuth();
  const email = "ghost@example.test";
  const userId = await seedIdentity(t, email);
  const as = t.withIdentity({ subject: userId, email });
  const ANON = "anon_11111111-2222-3333-4444-555555555555";

  const monitorId = await t.run((ctx) =>
    ctx.db.insert(
      "monitors",
      monitorRow(ANON, { isAnonymous: true, anonymousEmail: email, checkInterval: "24h" })
    )
  );

  await as.mutation(api.account.deleteAccount, {});
  await settle(t);

  await expect(
    as.mutation(api.anonymous.claimMyAnonymousMonitors, { monitorId, anonId: ANON })
  ).resolves.toEqual({ transferred: 0 });

  await t.run(async (ctx) => {
    const monitor = await ctx.db.get(monitorId);
    expect(monitor?.userId).toBe(ANON);
    expect(monitor?.isAnonymous).toBe(true);
  });
});

test("a deleted account's leftover token leaves no activity stamp behind", async () => {
  const t = withAuth();
  const email = "ghost@example.test";
  const userId = await seedIdentity(t, email);
  const as = t.withIdentity({ subject: userId, email });

  await as.mutation(api.account.deleteAccount, {});
  await settle(t);

  await expect(as.mutation(api.account.touchLastSeen, {})).resolves.toBeNull();

  await t.run(async (ctx) => {
    expect(await ctx.db.query("userActivity").collect()).toHaveLength(0);
  });
});

test("a deleted account's leftover token cannot dismiss the review prompt into a new tier row", async () => {
  const t = withAuth();
  const email = "ghost@example.test";
  const userId = await seedIdentity(t, email);
  const as = t.withIdentity({ subject: userId, email });

  await as.mutation(api.account.deleteAccount, {});
  await settle(t);

  await expect(as.mutation(api.reviews.dismiss, {})).resolves.toBeNull();

  await t.run(async (ctx) => {
    expect(await ctx.db.query("userTiers").collect()).toHaveLength(0);
  });
});

/**
 * A dead session that keeps navigating used to write a fresh activity stamp
 * on every page, and ten minutes later the audit found it and raised the
 * "sweep stopped early" alarm for a sweep that had finished fine.
 */
test("a deleted session that keeps navigating does not trip the erasure alarm", async () => {
  const t = withAuth();
  const email = "ghost@example.test";
  const userId = await seedIdentity(t, email);
  const as = t.withIdentity({ subject: userId, email });

  await as.mutation(api.account.deleteAccount, {});
  await as.mutation(api.account.touchLastSeen, {});
  await as.mutation(api.anonymous.claimMyAnonymousMonitors, {});
  await as.mutation(api.reviews.dismiss, {});
  await settle(t);

  expect(await adminAlerts(t, "survived")).toBe(0);
});

/**
 * The writers behind a button. Each puts a row keyed to the dead id back in
 * the database, so each refuses the way monitors.create does.
 */
test("a deleted account cannot register a push device", async () => {
  const t = withAuth();
  const email = "ghost@example.test";
  const userId = await seedIdentity(t, email);
  const as = t.withIdentity({ subject: userId, email });

  await as.mutation(api.account.deleteAccount, {});
  await settle(t);

  await expect(
    as.mutation(api.pushSubscriptions.subscribe, {
      endpoint: "https://push.test/ghost",
      p256dh: "key",
      auth: "auth",
    })
  ).rejects.toThrow(/no longer exists/i);

  await t.run(async (ctx) => {
    expect(await ctx.db.query("pushSubscriptions").collect()).toHaveLength(0);
  });
});

test("a deleted account cannot write a check log", async () => {
  const t = withAuth();
  const email = "ghost@example.test";
  const userId = await seedIdentity(t, email);
  const as = t.withIdentity({ subject: userId, email });

  await as.mutation(api.account.deleteAccount, {});
  await settle(t);

  await expect(
    as.mutation(api.logs.create, {
      url: "https://shop.test/laptops",
      prompt: "MacBook under £1000",
      status: "success",
      durationMs: 1,
    })
  ).rejects.toThrow(/no longer exists/i);

  await t.run(async (ctx) => {
    expect(await ctx.db.query("scrapeLogs").collect()).toHaveLength(0);
  });
});

test("a deleted account cannot consume a scan into a new tier row", async () => {
  const t = withAuth();
  const email = "ghost@example.test";
  const userId = await seedIdentity(t, email);
  const as = t.withIdentity({ subject: userId, email });

  await as.mutation(api.account.deleteAccount, {});
  await settle(t);

  await expect(as.mutation(api.tiers.consumeScan, {})).rejects.toThrow(/no longer exists/i);

  await t.run(async (ctx) => {
    expect(await ctx.db.query("userTiers").collect()).toHaveLength(0);
  });
});
