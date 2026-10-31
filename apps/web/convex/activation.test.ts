/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, components, internal } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 9, 20, 12) }));
afterEach(() => vi.useRealTimers());

function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}
type T = ReturnType<typeof setup>;

async function seedUser(t: T, email: string) {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: { model: "user", data: { name: "A Person", email, emailVerified: true, createdAt: Date.now(), updatedAt: Date.now() } },
  })) as { _id: string };
  return t.withIdentity({ subject: user._id, email });
}

/** Scheduled jobs by function name, whatever became of them. */
async function jobs(t: T, name: string): Promise<Record<string, unknown>[]> {
  return t.run(async (ctx) => {
    const all = await ctx.db.system.query("_scheduled_functions").collect();
    return all.filter((j) => j.name === name).map((j) => (j.args as [Record<string, unknown>])[0]!);
  });
}

const MONITOR = { url: "https://example.com/huts", prompt: "any Feb start date", name: "Milford", checkInterval: "24h" as const };

// The user was told "we'll keep trying". Without this they never hear that we
// did, and with it firing on every check they would get it every hour.
test("a blocked first scan that later reads fine emails the owner and activates them, once", async () => {
  const t = setup();
  const owner = await seedUser(t, "a@example.com");
  const id = await owner.mutation(api.monitors.create, MONITOR);
  await owner.mutation(api.monitors.saveScanError, { id, error: "Site is blocking automated access: HTTP 403" });

  const success = { monitorId: id, hasNewMatches: true, matchCount: 2, totalItems: 5, matches: [] };
  await t.mutation(internal.scheduler.recordCheckResult, success);
  await t.mutation(internal.scheduler.recordCheckResult, success);

  const emails = await jobs(t, "emails:sendFirstReadAlert");
  expect(emails).toHaveLength(1);
  expect(emails[0]).toMatchObject({ to: "a@example.com", matchCount: 2 });
  const activated = (await jobs(t, "admin:notify")).filter((a) => String(a.text).includes("Activated"));
  expect(activated).toHaveLength(1);
});

test("a monitor whose first scan worked gets no 'we got in' email", async () => {
  const t = setup();
  const owner = await seedUser(t, "a@example.com");
  const id = await owner.mutation(api.monitors.create, MONITOR);
  await owner.mutation(api.monitors.saveScanResult, { id, schema: { items: [] }, matchCount: 0 });
  await t.mutation(internal.scheduler.recordCheckResult, { monitorId: id, hasNewMatches: false, matchCount: 0, totalItems: 0, matches: [] });

  expect(await jobs(t, "emails:sendFirstReadAlert")).toHaveLength(0);
});

// A ping per visit would bury the ones that matter: someone coming back.
test("coming back after three days away pings the admin; an ordinary visit does not", async () => {
  const t = setup();
  const owner = await seedUser(t, "a@example.com");
  await owner.mutation(api.account.touchLastSeen, {});

  vi.advanceTimersByTime(2 * 60 * 60 * 1000);
  await owner.mutation(api.account.touchLastSeen, {});
  expect(await jobs(t, "admin:notify")).toHaveLength(0);

  vi.advanceTimersByTime(4 * 24 * 60 * 60 * 1000);
  await owner.mutation(api.account.touchLastSeen, {});
  const pings = await jobs(t, "admin:notify");
  expect(pings).toHaveLength(1);
  expect(String(pings[0]!.text)).toContain("after 4 days away");
});
