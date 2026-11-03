/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import schema from "./schema";
import betterAuthSchema from "./betterAuth/schema";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

async function signUp(t: ReturnType<typeof harness>, email: string, betaOn = true) {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: { name: "A Person", email, emailVerified: true, createdAt: 0, updatedAt: 0 },
    },
  })) as { _id: string };
  const as = t.withIdentity({ subject: user._id, email });
  if (betaOn) await as.mutation(api.betaFeatures.set, { feature: "find_a_product", enabled: true });
  return { as, userId: user._id };
}

const listing = (site: string, watch: boolean) => ({
  site,
  url: `https://${site}/xm5`,
  title: "Sony WH-1000XM5",
  price: 27999,
  currency: "GBP",
  inStock: false,
  label: "same" as const,
  watch,
});

const PRODUCT = {
  name: "Sony WH-1000XM5",
  region: "GB",
  alertOn: { backInStock: true },
  notificationChannels: ["email" as const],
  checkInterval: "1h" as const,
  listings: [listing("argos.co.uk", true), listing("currys.co.uk", true), listing("johnlewis.com", false)],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("monitorGroups.create", () => {
  // The product only works if each ticked listing becomes a monitor carrying
  // the product's criteria, and nothing else does.
  it("creates one monitor per ticked listing, with the product's criteria, and keeps the rest as suggestions", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");

    const { groupId, monitorIds } = await as.mutation(api.monitorGroups.create, PRODUCT);

    const monitors = await as.query(api.monitors.list, {});
    expect(monitors).toHaveLength(2);
    expect(monitorIds).toHaveLength(2);
    for (const m of monitors) {
      expect(m.groupId).toBe(groupId);
      expect(m.alertOn).toEqual({ backInStock: true });
      expect(m.notificationChannels).toEqual(["email"]);
      expect(m.checkInterval).toBe("1h");
      expect(m.prompt).toBe("Track this product's stock: Sony WH-1000XM5");
      // Active with no schema is what makes the scheduler do the first scan.
      expect(m.status).toBe("active");
      expect(m.nextCheckAt).toBeLessThanOrEqual(Date.now());
    }

    const group = await as.query(api.monitorGroups.get, { id: groupId });
    expect(group?.listings.map((l) => [l.site, l.state, l.monitorId !== undefined])).toEqual([
      ["argos.co.uk", "watching", true],
      ["currys.co.uk", "watching", true],
      ["johnlewis.com", "suggested", false],
    ]);
  });

  it("refuses a user with the beta off", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test", false);

    await expect(as.mutation(api.monitorGroups.create, PRODUCT)).rejects.toThrow("beta feature");
    expect(await as.query(api.monitors.list, {})).toHaveLength(0);
  });

  // The client caps ticks at free slots, but a second tab or a stale count
  // can still ask for more. Half a product would be worse than none.
  it("creates nothing when the ticks don't fit the plan's monitor limit", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) {
        await ctx.db.insert("monitors", {
          userId,
          name: `Existing ${i}`,
          url: `https://shop.test/${i}`,
          prompt: "anything",
          status: "paused",
          checkInterval: "24h",
          matchCount: 0,
          createdAt: 0,
          updatedAt: 0,
        });
      }
    });

    await expect(as.mutation(api.monitorGroups.create, PRODUCT)).rejects.toThrow("allows 3 monitors");
    expect(await as.query(api.monitors.list, {})).toHaveLength(2);
    expect(await t.run((ctx) => ctx.db.query("monitorGroups").collect())).toHaveLength(0);
  });

  // Free allows Telegram and Discord on one monitor. A product is one thing to
  // the user, so all its listings get them, or none do. Per listing, only the
  // first would alert there.
  it("gives a free user's listings one channel list, counting the product as one monitor", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const telegram = { ...PRODUCT, notificationChannels: ["telegram" as const] };

    const first = await as.mutation(api.monitorGroups.create, {
      ...telegram,
      listings: [listing("argos.co.uk", true), listing("currys.co.uk", true)],
    });
    const monitors = await as.query(api.monitors.list, {});
    expect(monitors.map((m) => m.notificationChannels)).toEqual([["telegram"], ["telegram"]]);
    expect((await as.query(api.monitorGroups.get, { id: first.groupId }))?.notificationChannels).toEqual(["telegram"]);

    // A second product is a second monitor on Telegram, which free doesn't allow.
    const second = await as.mutation(api.monitorGroups.create, { ...telegram, listings: [listing("johnlewis.com", true)] });
    expect((await as.query(api.monitors.get, { id: second.monitorIds[0]! }))?.notificationChannels).toEqual([]);
    expect((await as.query(api.monitorGroups.get, { id: second.groupId }))?.notificationChannels).toEqual([]);
  });

  // Each creation buys a paid AI read. The client caps ticks from
  // creationAllowance; the server must hold the line if it is stale.
  it("creates nothing past the creation rate limit, and reports the creations the client counts", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    const now = Date.now();
    await t.run(async (ctx) => {
      for (let i = 0; i < 2; i++) await ctx.db.insert("monitorCreations", { userId, createdAt: now - i });
    });

    expect((await as.query(api.monitors.creationAllowance, {}))?.recent).toHaveLength(2);
    await expect(as.mutation(api.monitorGroups.create, PRODUCT)).rejects.toThrow("Creation limit");
    expect(await t.run((ctx) => ctx.db.query("monitorGroups").collect())).toHaveLength(0);
    expect(await as.query(api.monitors.list, {})).toHaveLength(0);
  });

  it("does not show one user's product to another", async () => {
    const t = harness();
    const { as: owner } = await signUp(t, "a@example.test");
    const { as: other } = await signUp(t, "b@example.test");

    const { groupId } = await owner.mutation(api.monitorGroups.create, PRODUCT);

    expect(await other.query(api.monitorGroups.get, { id: groupId })).toBeNull();
    expect(await other.query(api.monitors.list, {})).toHaveLength(0);
  });

  // A listing left "watching" a deleted monitor would show as watched forever
  // and could never be watched again.
  it("puts a listing back to suggested when its monitor is deleted", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { groupId, monitorIds } = await as.mutation(api.monitorGroups.create, PRODUCT);

    await as.mutation(api.monitors.remove, { id: monitorIds[0]! });

    const group = await as.query(api.monitorGroups.get, { id: groupId });
    expect(group?.listings[0]).toMatchObject({ state: "suggested", monitor: null });
    expect(group?.listings[0]?.monitorId).toBeUndefined();
  });
});

describe("monitorGroups.listMine", () => {
  // Before any check the card has only the search's facts, and only the owner
  // may see them.
  it("sums up the owner's product from the search before any check, and shows it to nobody else", async () => {
    const t = harness();
    const { as: owner } = await signUp(t, "a@example.test");
    const { as: other } = await signUp(t, "b@example.test");
    const { groupId } = await owner.mutation(api.monitorGroups.create, PRODUCT);

    expect(await owner.query(api.monitorGroups.listMine, {})).toEqual([
      {
        _id: groupId,
        name: "Sony WH-1000XM5",
        watching: 2,
        cheapest: { price: 27999, currency: "GBP", site: "argos.co.uk" },
        inStock: false,
        lastCheckedAt: undefined,
        paused: 0,
        errored: 0,
      },
    ]);
    expect(await other.query(api.monitorGroups.listMine, {})).toEqual([]);
  });

  // The card is the live view of a product: a stale search price, or one
  // listing's state hiding another's, would tell the user the wrong thing.
  it("uses each listing's last read, and counts paused and errored listings", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { monitorIds } = await as.mutation(api.monitorGroups.create, PRODUCT);
    await t.run(async (ctx) => {
      await ctx.db.patch(monitorIds[0]!, { status: "paused", lastCheckedAt: 1000 });
      await ctx.db.patch(monitorIds[1]!, {
        status: "error",
        lastCheckedAt: 2000,
        lastSeen: { price: 25999, currency: "GBP", inStock: true },
      });
    });

    const [product] = await as.query(api.monitorGroups.listMine, {});
    expect(product).toMatchObject({
      cheapest: { price: 25999, currency: "GBP", site: "currys.co.uk" },
      inStock: true,
      lastCheckedAt: 2000,
      paused: 1,
      errored: 1,
    });
  });

  // 100 cents is not cheaper than 25999 pence in any useful sense.
  it("takes the cheapest price in the most common currency", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { monitorIds } = await as.mutation(api.monitorGroups.create, {
      ...PRODUCT,
      listings: [listing("argos.co.uk", true), listing("currys.co.uk", true), listing("amazon.com", true)],
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(monitorIds[1]!, { lastSeen: { price: 25999, currency: "GBP" } });
      await ctx.db.patch(monitorIds[2]!, { lastSeen: { price: 100, currency: "USD" } });
    });

    const [product] = await as.query(api.monitorGroups.listMine, {});
    expect(product?.cheapest).toEqual({ price: 25999, currency: "GBP", site: "currys.co.uk" });
  });
});

// A monitor moved to another page would otherwise go on reading that page
// for the old listing's title, and the product would show it as that listing.
it("takes a monitor out of its product when its URL changes", async () => {
  const t = harness();
  const { as } = await signUp(t, "a@example.test");
  const { groupId, monitorIds } = await as.mutation(api.monitorGroups.create, PRODUCT);
  const id = monitorIds[0]!;

  await as.mutation(api.monitors.update, { id, url: "https://shop.test/other" });

  const monitor = await t.run((ctx) => ctx.db.get(id));
  expect(monitor?.groupId).toBeUndefined();
  expect(monitor?.productTitle).toBeUndefined();
  const group = await as.query(api.monitorGroups.get, { id: groupId });
  expect(group?.listings[0]).toMatchObject({ state: "suggested", monitor: null });
});

describe("a product's monitors on the scheduler", () => {
  function stubScraper(onQuickCheck: (body: Record<string, unknown>) => void = () => {}) {
    vi.stubEnv("SCRAPER_URL", "https://scraper.test");
    vi.stubEnv("SCRAPER_API_KEY", "key");
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      if (url.endsWith("/api/extract")) {
        return Response.json({
          schema: { items: [{ title: "Carry case" }, { title: "Sony WH-1000XM5" }], matchConditions: {} },
          matches: [],
          totalItems: 2,
          contentHash: "page-1",
        });
      }
      if (url.endsWith("/api/quick-check")) {
        onQuickCheck(JSON.parse(init.body) as Record<string, unknown>);
        return Response.json({ accessible: true, contentHash: "page-1", candidates: [], totalEntries: 2 });
      }
      return new Response("not mocked", { status: 500 });
    });
  }

  // The first scan has to happen with nobody in the browser, and must not
  // email the user once per listing about a scan they watched in the app.
  it("first-scans a new listing on the server, without a first-read email", async () => {
    stubScraper();
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { monitorIds } = await as.mutation(api.monitorGroups.create, { ...PRODUCT, listings: [listing("argos.co.uk", true)] });

    await t.action(internal.scheduler.runScheduledChecks, {});

    const monitor = await as.query(api.monitors.get, { id: monitorIds[0]! });
    expect(monitor?.checkCount).toBe(1);
    expect(monitor?.schema).toBeDefined();
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.some((job) => job.name.includes("sendFirstReadAlert"))).toBe(false);
  });

  // A listing that only got in after retries finished long after the user
  // left the progress screen. Without the email they never hear it worked.
  it("sends the first-read email when a listing's first read comes late", async () => {
    stubScraper();
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { monitorIds } = await as.mutation(api.monitorGroups.create, { ...PRODUCT, listings: [listing("argos.co.uk", true)] });
    await t.run((ctx) => ctx.db.patch(monitorIds[0]!, { createdAt: Date.now() - 60 * 60 * 1000 }));

    await t.action(internal.scheduler.runScheduledChecks, {});

    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.some((job) => job.name.includes("sendFirstReadAlert"))).toBe(true);
  });

  // A product page often lists related items too. Without the product gate
  // those listings would never be read for stock or price, and never alert.
  // The title finds the product on the page, so a rename must not move it.
  it("reads the product on a listing whose page shows several items, by the listing's title, even once renamed", async () => {
    let productTitle: unknown;
    stubScraper((body) => (productTitle = body.productTitle));
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { monitorIds } = await as.mutation(api.monitorGroups.create, { ...PRODUCT, listings: [listing("argos.co.uk", true)] });
    const id = monitorIds[0]!;
    await t.action(internal.scheduler.runScheduledChecks, {});
    await as.mutation(api.monitors.update, { id, name: "My headphones" });
    await t.run((ctx) => ctx.db.patch(id, { nextCheckAt: 0 }));

    await t.action(internal.scheduler.runScheduledChecks, {});

    expect(productTitle).toBe("Sony WH-1000XM5");
  });
});
