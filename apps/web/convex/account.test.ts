/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { WithoutSystemFields } from "convex/server";
import { describe, expect, it, vi } from "vitest";
import { deleteAllUserData } from "./account";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.*s");

type Row<T extends TableNames> = WithoutSystemFields<Doc<T>>;
type Refs = { userId: string; monitorId: Id<"monitors"> };

const NOW = 1_700_000_000_000;

function monitorRow(userId: string): Row<"monitors"> {
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
  };
}

/**
 * One row per table, belonging to `userId`. The mapped type means a table
 * added to the schema does not compile until it has a fixture here and a
 * verdict in KEPT_ON_DELETE or in deleteAllUserData. That is the point:
 * "delete everything" is a promise in the privacy policy, and the last two
 * tables added to the schema were both missed.
 */
const FIXTURES: { [T in TableNames]: (refs: Refs) => Row<T> } = {
  monitors: ({ userId }) => monitorRow(userId),
  scrapeResults: ({ monitorId }) => ({
    monitorId,
    matches: [],
    totalItems: 0,
    hasNewMatches: false,
    scrapedAt: NOW,
  }),
  notifications: ({ userId, monitorId }) => ({
    userId,
    monitorId,
    channel: "email",
    title: "Match",
    message: "Found one",
    sentAt: NOW,
    read: false,
  }),
  scrapeLogs: ({ userId, monitorId }) => ({
    userId,
    monitorId,
    url: "https://shop.test/laptops",
    prompt: "MacBook under £1000",
    status: "success",
    durationMs: 1,
    createdAt: NOW,
  }),
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
  onboardingEmails: ({ userId }) => ({
    userId,
    email: `${userId}@example.test`,
    step: "day0",
    scheduledFor: NOW,
    status: "pending",
  }),
};

/** Tables deleteAllUserData leaves alone, each with the reason it is allowed to. */
const KEPT_ON_DELETE: Partial<Record<TableNames, string>> = {
  bannedUsers: "a ban has to outlive the account it was placed on",
  appliedOrders: "opaque Polar order ids; the guard against a redelivered order webhook",
  adminEmails: "the operator's record of what was sent and to whom",
  counters: "aggregate, holds no personal data",
  anonymousScanCounter: "aggregate, holds no personal data",
};

const TABLES = Object.keys(schema.tables) as TableNames[];

async function insertRowsFor(
  ctx: Parameters<Parameters<ReturnType<typeof convexTest>["run"]>[0]>[0],
  userId: string,
): Promise<Record<TableNames, Id<TableNames>>> {
  const monitorId = await ctx.db.insert("monitors", monitorRow(userId));
  const ids = { monitors: monitorId } as Record<TableNames, Id<TableNames>>;
  for (const table of TABLES) {
    if (table === "monitors") continue;
    ids[table] = await ctx.db.insert(table, FIXTURES[table]({ userId, monitorId }));
  }
  return ids;
}

describe("deleteAllUserData", () => {
  it("has a verdict for every table in the schema", () => {
    // The mapped type catches this at compile time; vitest does not type-check,
    // so the same claim is asserted at runtime.
    expect(Object.keys(FIXTURES).sort()).toEqual([...TABLES].sort());
  });

  it("removes the user's rows from every table not deliberately kept, and nobody else's", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);

    const { mine, theirs } = await t.run(async (ctx) => ({
      mine: await insertRowsFor(ctx, "user-leaving"),
      theirs: await insertRowsFor(ctx, "user-staying"),
    }));

    await t.run((ctx) => deleteAllUserData(ctx, "user-leaving", "user-leaving@example.test"));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    await t.run(async (ctx) => {
      for (const table of TABLES) {
        const kept = table in KEPT_ON_DELETE;
        const survivor = await ctx.db.get(mine[table]);
        if (kept) {
          expect(survivor, `${table} is listed as kept but was deleted`).not.toBeNull();
        } else {
          expect(survivor, `${table} row survived account deletion`).toBeNull();
        }
        expect(await ctx.db.get(theirs[table]), `${table} row of another user was deleted`).not.toBeNull();
      }
    });
    vi.useRealTimers();
  });

  /**
   * The fixture above tags its emailSends row with a userId, which only the
   * onboarding and inactivity emails actually do. Match, error,
   * monitor-stopped, price, anonymous-scan and bulk all record with userId
   * undefined, so a by_userId sweep leaves a year of alerts behind with the
   * address still in `to` — and the privacy policy promises otherwise.
   */
  it("removes email records that were never tagged with a userId", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const email = "user-leaving@example.test";

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

    await t.run((ctx) => deleteAllUserData(ctx, "user-leaving", email));
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    await t.run(async (ctx) => {
      expect(await ctx.db.get(untagged), "an untagged send to this address survived").toBeNull();
      expect(await ctx.db.get(otherPerson), "another person's send was deleted").not.toBeNull();
    });
    vi.useRealTimers();
  });
});
