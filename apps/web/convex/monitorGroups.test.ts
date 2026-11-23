/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import schema from "./schema";
import betterAuthSchema from "./betterAuth/schema";
import type { Doc, Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

// No beta opt-in: Find a product is on for everyone, so every test here runs as a user who never touched Settings.
async function signUp(t: ReturnType<typeof harness>, email: string) {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: { name: "A Person", email, emailVerified: true, createdAt: 0, updatedAt: 0 },
    },
  })) as { _id: string };
  const as = t.withIdentity({ subject: user._id, email });
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
  vi.useRealTimers();
});

describe("monitorGroups.create", () => {
  // Two links to one page would be two monitors, and two slots, for one listing.
  it("keeps one listing per page when links differ only by tracking parameters", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const tracked = { ...listing("argos.co.uk", true), url: "https://www.argos.co.uk/xm5?utm_source=x" };

    const { groupId, monitorIds } = await as.mutation(api.monitorGroups.create, {
      ...PRODUCT,
      listings: [listing("argos.co.uk", true), tracked],
    });

    expect(monitorIds).toHaveLength(1);
    expect((await as.query(api.monitorGroups.get, { id: groupId }))?.listings.map((l) => l.url)).toEqual([
      "https://argos.co.uk/xm5",
    ]);
  });

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

  // Prices are stored in minor units. A 279.99 or a -1 from a bad client would
  // show on the product card as £2.80 or as a negative price.
  it("drops listing prices that are not whole, non-negative minor units", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const priced = (site: string, price: number) => ({ ...listing(site, true), price });

    const { groupId } = await as.mutation(api.monitorGroups.create, {
      ...PRODUCT,
      listings: [priced("argos.co.uk", 27999), priced("currys.co.uk", 279.99), priced("johnlewis.com", -1)],
    });

    const group = await as.query(api.monitorGroups.get, { id: groupId });
    expect(group?.listings.map((l) => l.price)).toEqual([27999, undefined, undefined]);
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

  // A product's listings share one channel list, and free has no cap on
  // which monitors use Telegram: a second product gets it too.
  it("gives a free user's listings one channel list, on every product", async () => {
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

    const second = await as.mutation(api.monitorGroups.create, { ...telegram, listings: [listing("johnlewis.com", true)] });
    expect((await as.query(api.monitors.get, { id: second.monitorIds[0]! }))?.notificationChannels).toEqual(["telegram"]);
    expect((await as.query(api.monitorGroups.get, { id: second.groupId }))?.notificationChannels).toEqual(["telegram"]);
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

  // A tie decided by read order would make the card's price flip between checks.
  it("breaks a currency tie by the product's region, then alphabetically", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { groupId, monitorIds } = await as.mutation(api.monitorGroups.create, PRODUCT);
    await t.run(async (ctx) => {
      await ctx.db.patch(monitorIds[1]!, { lastSeen: { price: 100, currency: "USD" } });
      await ctx.db.patch(groupId, { region: "US" });
    });
    const [usProduct] = await as.query(api.monitorGroups.listMine, {});
    expect(usProduct?.cheapest).toEqual({ price: 100, currency: "USD", site: "currys.co.uk" });

    await t.run((ctx) => ctx.db.patch(groupId, { region: "DE" }));
    const [deProduct] = await as.query(api.monitorGroups.listMine, {});
    expect(deProduct?.cheapest).toEqual({ price: 27999, currency: "GBP", site: "argos.co.uk" });
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

  // A rescan from the listing's own page goes through the browser's scan
  // save. It must stay as quiet about matches as the scheduler is.
  it("sends no match alert when a listing's rescan finds matches", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { monitorIds } = await as.mutation(api.monitorGroups.create, { ...PRODUCT, listings: [listing("argos.co.uk", true)] });
    const id = monitorIds[0]!;
    await t.run((ctx) => ctx.db.patch(id, { status: "scanning" }));

    await as.mutation(api.monitors.saveScanResult, {
      id,
      schema: { items: [{ title: "Sony WH-1000XM5" }, { title: "Carry case" }] },
      matchCount: 2,
    });

    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.some((job) => job.name.includes("sendInitialScanNotifications"))).toBe(false);
    expect((await as.query(api.monitors.get, { id }))?.status).toBe("active");
  });

  // A site going down fails every listing of a product on it, and a scraper
  // fault fails all of them. One email per listing is a pile of identical mail.
  // A park is different: it is the last word on that listing, so each one
  // has to reach the user.
  it("sends one error email per product, but a checks-stopped email per listing", async () => {
    vi.stubEnv("SCRAPER_URL", "https://scraper.test");
    vi.stubEnv("SCRAPER_API_KEY", "key");
    vi.stubEnv("RESEND_API_KEY", "key");
    const subjects: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      if (url.includes("resend.com")) {
        subjects.push((JSON.parse(init.body) as { subject: string }).subject);
        return Response.json({ id: "email" });
      }
      return Response.json({ message: "Site is down" }, { status: 500 });
    });
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { monitorIds } = await as.mutation(api.monitorGroups.create, PRODUCT);
    const failAll = async (fields: { status: "active" | "error"; checkCount: number; retryCount: number }) => {
      await t.run(async (ctx) => {
        for (const id of monitorIds) {
          await ctx.db.patch(id, { ...fields, schema: { items: [], matchConditions: {} }, nextCheckAt: 0 });
        }
      });
      await t.action(internal.scheduler.runScheduledChecks, {});
    };
    const emails = async (kind: string) =>
      (await t.run((ctx) => ctx.db.query("emailSends").collect())).filter((e) => e.kind === kind).length;

    await failAll({ status: "active", checkCount: 5, retryCount: 2 });
    expect(await emails("error")).toBe(1);
    // Named by product and site, not by a count that a batch of parallel checks undercounts.
    expect(subjects.filter((s) => s.startsWith("Monitor error"))).toEqual([
      expect.stringMatching(/^Monitor error: Sony WH-1000XM5 on (argos\.co\.uk|currys\.co\.uk)$/),
    ]);
    // Each listing still gets its in-app notice, which records which one failed.
    expect(await t.run((ctx) => ctx.db.query("notifications").collect())).toHaveLength(2);

    await failAll({ status: "error", checkCount: 0, retryCount: 31 });
    expect(await emails("monitor-stopped")).toBe(2);
    expect(subjects.filter((s) => s.startsWith("Checks stopped")).sort()).toEqual([
      "Checks stopped: Sony WH-1000XM5 on argos.co.uk",
      "Checks stopped: Sony WH-1000XM5 on currys.co.uk",
    ]);
  });

  // A listing that can't reach the user sends nothing. If it took the
  // product's one error alert, the listing that can email would stay silent.
  it.each([
    ["no channels", []],
    ["Discord, not connected", ["discord"]],
    ["push, with no device", ["push"]],
  ] as const)("doesn't let a listing with %s use up the product's error alert", async (_, silentChannels) => {
    vi.stubEnv("SCRAPER_URL", "https://scraper.test");
    vi.stubEnv("SCRAPER_API_KEY", "key");
    vi.stubGlobal("fetch", async () => Response.json({ message: "Site is down" }, { status: 500 }));
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { monitorIds } = await as.mutation(api.monitorGroups.create, PRODUCT);
    const [silent, emailing] = monitorIds as [Id<"monitors">, Id<"monitors">];
    await t.run((ctx) => ctx.db.patch(silent, { notificationChannels: [...silentChannels] }));
    const fail = async (id: Id<"monitors">) => {
      await t.run((ctx) =>
        ctx.db.patch(id, { status: "active", checkCount: 5, retryCount: 2, schema: { items: [], matchConditions: {} }, nextCheckAt: 0 })
      );
      await t.action(internal.scheduler.runScheduledChecks, {});
    };

    await fail(silent);
    await fail(emailing);

    const sends = await t.run((ctx) => ctx.db.query("emailSends").collect());
    expect(sends.filter((e) => e.kind === "error").map((e) => e.monitorId)).toEqual([emailing]);
  });

  // A product page lists cases and bundles next to the product. Each new one
  // would send a "new match" alert the user never asked for: a product only
  // alerts on stock and price.
  it("sends no match alert when a listing's page gains a matching item, but still records it", async () => {
    let candidates = [{ title: "Sony WH-1000XM5", url: "https://argos.co.uk/xm5", price: null, snippet: "" }];
    let hash = 0;
    vi.stubEnv("SCRAPER_URL", "https://scraper.test");
    vi.stubEnv("SCRAPER_API_KEY", "key");
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/api/quick-check")) {
        return Response.json({ accessible: true, contentHash: `page-${++hash}`, candidates, totalEntries: candidates.length });
      }
      if (url.endsWith("/api/score")) {
        return Response.json({ scored: candidates.slice(1).map((c) => ({ ...c, matchScore: 90, matchReason: "" })) });
      }
      return new Response("not mocked", { status: 500 });
    });
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { monitorIds } = await as.mutation(api.monitorGroups.create, { ...PRODUCT, listings: [listing("argos.co.uk", true)] });
    const id = monitorIds[0]!;
    await t.run((ctx) =>
      ctx.db.patch(id, { schema: { items: [], matchConditions: {} }, checkCount: 1, lastAiExtractAt: Date.now() })
    );
    const check = async () => {
      await t.run((ctx) => ctx.db.patch(id, { nextCheckAt: 0 }));
      await t.action(internal.scheduler.runScheduledChecks, {});
    };

    await check();
    candidates = [...candidates, { title: "Sony WH-1000XM5 case", url: "https://argos.co.uk/case", price: null, snippet: "" }];
    await check();

    const result = await t.run((ctx) => ctx.db.query("scrapeResults").order("desc").first());
    expect(result?.hasNewMatches).toBe(true);
    expect(await t.run((ctx) => ctx.db.query("notifications").collect())).toHaveLength(0);
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.some((job) => job.name.includes("notify"))).toBe(false);
  });
});

describe("managing a product", () => {
  // A product edit that missed a monitor would leave that listing alerting on
  // the old criteria, or on channels the user just turned off.
  it("rewrites every monitor's criteria, channels, interval and prompt", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { groupId } = await as.mutation(api.monitorGroups.create, PRODUCT);

    await as.mutation(api.monitorGroups.updateCriteria, {
      id: groupId,
      alertOn: { priceDrop: true },
      notificationChannels: ["push"],
      checkInterval: "6h",
    });

    const monitors = await as.query(api.monitors.list, {});
    expect(monitors).toHaveLength(2);
    for (const m of monitors) {
      expect(m.alertOn).toEqual({ priceDrop: true });
      expect(m.notificationChannels).toEqual(["push"]);
      expect(m.checkInterval).toBe("6h");
      expect(m.prompt).toBe("Track this product's price: Sony WH-1000XM5");
    }
    const group = await as.query(api.monitorGroups.get, { id: groupId });
    expect(group).toMatchObject({ alertOn: { priceDrop: true }, notificationChannels: ["push"], checkInterval: "6h" });
  });

  // A listing out of step with its monitor shows as watched with nothing
  // watching it, or watches a page the product says it doesn't.
  it("starts and stops watching a listing, keeping the listing and its monitor in step", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { groupId } = await as.mutation(api.monitorGroups.create, PRODUCT);
    const url = "https://johnlewis.com/xm5";

    const { monitorId } = await as.mutation(api.monitorGroups.watchListing, { id: groupId, url });
    const monitor = await as.query(api.monitors.get, { id: monitorId });
    expect(monitor).toMatchObject({ groupId, alertOn: { backInStock: true }, status: "active" });
    let group = await as.query(api.monitorGroups.get, { id: groupId });
    expect(group?.listings[2]).toMatchObject({ state: "watching", monitorId });

    await as.mutation(api.monitorGroups.unwatchListing, { id: groupId, url });
    expect(await as.query(api.monitors.get, { id: monitorId })).toBeNull();
    group = await as.query(api.monitorGroups.get, { id: groupId });
    expect(group?.listings[2]).toMatchObject({ state: "suggested", monitor: null });
    expect(group?.listings[2]?.monitorId).toBeUndefined();
  });

  // Watching from the product view must not get round the plan's limit.
  it("won't start watching past the plan's monitor limit", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { groupId } = await as.mutation(api.monitorGroups.create, {
      ...PRODUCT,
      listings: [...PRODUCT.listings, listing("amazon.co.uk", true)],
    });
    // Out of the creation window, so the monitor limit is what stops it.
    await t.run(async (ctx) => {
      for (const c of await ctx.db.query("monitorCreations").collect()) await ctx.db.patch(c._id, { createdAt: 0 });
    });

    await expect(
      as.mutation(api.monitorGroups.watchListing, { id: groupId, url: "https://johnlewis.com/xm5" })
    ).rejects.toThrow("allows 3 monitors");
    const group = await as.query(api.monitorGroups.get, { id: groupId });
    expect(group?.listings.find((l) => l.site === "johnlewis.com")?.state).toBe("suggested");
  });

  it("hides a dismissed suggestion and can bring it back", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { groupId } = await as.mutation(api.monitorGroups.create, PRODUCT);
    const url = "https://johnlewis.com/xm5";

    await as.mutation(api.monitorGroups.setListingDismissed, { id: groupId, url, dismissed: true });
    expect((await as.query(api.monitorGroups.get, { id: groupId }))?.listings[2]?.state).toBe("dismissed");
    // A dismissed listing must be restored before it can be watched.
    await expect(as.mutation(api.monitorGroups.watchListing, { id: groupId, url })).rejects.toThrow("changed");

    await as.mutation(api.monitorGroups.setListingDismissed, { id: groupId, url, dismissed: false });
    expect((await as.query(api.monitorGroups.get, { id: groupId }))?.listings[2]?.state).toBe("suggested");
  });

  it("pauses and resumes every monitor in the product", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { groupId } = await as.mutation(api.monitorGroups.create, PRODUCT);

    await as.mutation(api.monitorGroups.setPaused, { id: groupId, paused: true });
    expect((await as.query(api.monitors.list, {})).map((m) => m.status)).toEqual(["paused", "paused"]);

    await as.mutation(api.monitorGroups.setPaused, { id: groupId, paused: false });
    expect((await as.query(api.monitors.list, {})).map((m) => m.status)).toEqual(["active", "active"]);
  });

  // Orphaned monitors would keep checking, alerting and using up plan slots
  // for a product the user deleted.
  it("deletes the product, its monitors and their history", async () => {
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { groupId, monitorIds } = await as.mutation(api.monitorGroups.create, PRODUCT);
    await t.run((ctx) =>
      ctx.db.insert("scrapeResults", {
        monitorId: monitorIds[0]!,
        matches: [],
        totalItems: 0,
        hasNewMatches: false,
        scrapedAt: 0,
      })
    );

    await as.mutation(api.monitorGroups.remove, { id: groupId });

    expect(await as.query(api.monitorGroups.get, { id: groupId })).toBeNull();
    expect(await as.query(api.monitors.list, {})).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("scrapeResults").collect())).toHaveLength(0);
  });

  // A product's history can be more than one transaction may delete. Done
  // in one go, the delete would fail and the user could never remove it.
  it("deletes history too big for one transaction in later rounds", async () => {
    vi.useFakeTimers();
    const t = harness();
    const { as } = await signUp(t, "a@example.test");
    const { groupId, monitorIds } = await as.mutation(api.monitorGroups.create, PRODUCT);
    await t.run(async (ctx) => {
      for (const monitorId of monitorIds) {
        for (let i = 0; i < 600; i++) {
          await ctx.db.insert("scrapeResults", { monitorId, matches: [], totalItems: 0, hasNewMatches: false, scrapedAt: i });
        }
      }
    });

    await as.mutation(api.monitorGroups.remove, { id: groupId });
    expect(await as.query(api.monitors.list, {})).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.query("scrapeResults").collect())).length).toBeGreaterThan(0);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query("scrapeResults").collect())).toHaveLength(0);
  });

  // The form shows what was saved. Without the plan's answer it would show
  // texts as on while none go out.
  it("returns the channels and interval a free plan allows", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    const { groupId } = await as.mutation(api.monitorGroups.create, PRODUCT);
    await t.run((ctx) =>
      ctx.db.insert("monitors", {
        userId,
        name: "Other",
        url: "https://shop.test/other",
        prompt: "anything",
        status: "paused",
        checkInterval: "24h",
        notificationChannels: ["telegram"],
        matchCount: 0,
        createdAt: 0,
        updatedAt: 0,
      })
    );

    const saved = await as.mutation(api.monitorGroups.updateCriteria, {
      id: groupId,
      alertOn: { backInStock: true },
      notificationChannels: ["email", "telegram", "sms"],
      checkInterval: "5m",
    });

    expect(saved).toEqual({ notificationChannels: ["email", "telegram"], checkInterval: "1h" });
    const group = await as.query(api.monitorGroups.get, { id: groupId });
    expect(group).toMatchObject({ notificationChannels: ["email", "telegram"], checkInterval: "1h" });
  });

  // The user is told what the new listing got, even when another monitor
  // already uses the same channel.
  it("gives a newly watched listing the product's channels", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    const { groupId } = await as.mutation(api.monitorGroups.create, {
      ...PRODUCT,
      notificationChannels: ["telegram"],
      listings: [listing("argos.co.uk", true), listing("currys.co.uk", false)],
    });
    await t.run((ctx) =>
      ctx.db.insert("monitors", {
        userId,
        name: "Other",
        url: "https://shop.test/other",
        prompt: "anything",
        status: "paused",
        checkInterval: "24h",
        notificationChannels: ["telegram"],
        matchCount: 0,
        createdAt: 0,
        updatedAt: 0,
      })
    );

    const got = await as.mutation(api.monitorGroups.watchListing, { id: groupId, url: "https://currys.co.uk/xm5" });

    expect(got.notificationChannels).toEqual(["telegram"]);
    expect((await as.query(api.monitorGroups.get, { id: groupId }))?.notificationChannels).toEqual(["telegram"]);
  });

  it("lets nobody but the owner change a product", async () => {
    const t = harness();
    const { as: owner } = await signUp(t, "a@example.test");
    const { as: other } = await signUp(t, "b@example.test");
    const { groupId } = await owner.mutation(api.monitorGroups.create, PRODUCT);
    const url = "https://johnlewis.com/xm5";

    const attempts = [
      () =>
        other.mutation(api.monitorGroups.updateCriteria, {
          id: groupId,
          alertOn: { priceDrop: true },
          notificationChannels: ["email"],
          checkInterval: "1h",
        }),
      () => other.mutation(api.monitorGroups.watchListing, { id: groupId, url }),
      () => other.mutation(api.monitorGroups.unwatchListing, { id: groupId, url: "https://argos.co.uk/xm5" }),
      () => other.mutation(api.monitorGroups.setListingDismissed, { id: groupId, url, dismissed: true }),
      () => other.mutation(api.monitorGroups.setPaused, { id: groupId, paused: true }),
      () => other.mutation(api.monitorGroups.remove, { id: groupId }),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow("Product not found");

    const group = await owner.query(api.monitorGroups.get, { id: groupId });
    expect(group?.alertOn).toEqual({ backInStock: true });
    expect(group?.listings.map((l) => l.state)).toEqual(["watching", "watching", "suggested"]);
    expect((await owner.query(api.monitors.list, {})).map((m) => m.status)).toEqual(["active", "active"]);
  });
});

// A monitor on one shop's product page becomes a product, so other shops can
// be searched and watched beside it. It must keep its history and settings,
// and only a page that is one product can be turned into one.
describe("monitorGroups.convertMonitor", () => {
  const PAGE = "https://www.argos.co.uk/product/123";

  async function seedMonitor(
    t: ReturnType<typeof harness>,
    userId: string,
    fields: Partial<Doc<"monitors">> = {}
  ): Promise<Id<"monitors">> {
    return t.run(async (ctx) => {
      const folderId = await ctx.db.insert("folders", { userId, name: "Audio", createdAt: 0, updatedAt: 0 });
      return ctx.db.insert("monitors", {
        userId,
        name: "XM5 headphones",
        url: PAGE,
        prompt: "tell me when it is back in stock",
        status: "active",
        checkInterval: "6h",
        notificationChannels: ["email"],
        schema: { items: [{ title: "Sony WH-1000XM5 Headphones", url: PAGE }, { title: "Case", url: "https://www.argos.co.uk/product/9" }] },
        matchCount: 0,
        lastMatchAt: 5,
        folderId,
        lastSeen: { inStock: false, price: 27999, currency: "GBP" },
        createdAt: 0,
        updatedAt: 0,
        ...fields,
      });
    });
  }

  it("turns the monitor into a product's first listing and keeps its history", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    const id = await seedMonitor(t, userId);
    await t.run((ctx) => ctx.db.insert("priceReads", { monitorId: id, price: 27999, currency: "GBP", readAt: 1 }));
    const folderId = (await t.run((ctx) => ctx.db.get(id)))!.folderId;

    const groupId = await as.mutation(api.monitorGroups.convertMonitor, { monitorId: id });

    const group = await t.run((ctx) => ctx.db.get(groupId));
    expect(group).toMatchObject({
      userId,
      name: "Sony WH-1000XM5 Headphones",
      region: "GB",
      alertOn: { backInStock: true },
      checkInterval: "6h",
      notificationChannels: ["email"],
      folderId,
      listings: [
        {
          site: "argos.co.uk",
          url: PAGE,
          title: "Sony WH-1000XM5 Headphones",
          price: 27999,
          currency: "GBP",
          label: "same",
          state: "watching",
          monitorId: id,
        },
      ],
    });
    // Stock was not read while no stock alert was on, so the old "out of
    // stock" is no reading at all: neither the listing nor the monitor keeps it.
    expect(group?.listings[0]).not.toHaveProperty("inStock");
    const monitor = (await t.run((ctx) => ctx.db.get(id)))!;
    expect(monitor.lastSeen?.inStock).toBeUndefined();
    // The match conditions came from the old prompt, so the next check re-reads.
    expect(monitor.lastAiExtractAt).toBe(0);
    expect(monitor).toMatchObject({ groupId, productTitle: "Sony WH-1000XM5 Headphones", alertOn: { backInStock: true }, lastMatchAt: 5 });
    expect(monitor.folderId).toBeUndefined();
    expect(monitor.prompt).toContain("Sony WH-1000XM5 Headphones");
    expect(await t.run((ctx) => ctx.db.query("priceReads").collect())).toHaveLength(1);
  });

  it("keeps alert settings it already has, and defaults when the prompt gives none", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    const kept = await seedMonitor(t, userId, { alertOn: { priceBelow: { amount: 25000, currency: "GBP" } } });
    const plain = await seedMonitor(t, userId, { prompt: "watch this page" });

    const keptGroup = await as.mutation(api.monitorGroups.convertMonitor, { monitorId: kept });
    const plainGroup = await as.mutation(api.monitorGroups.convertMonitor, { monitorId: plain });

    expect((await t.run((ctx) => ctx.db.get(keptGroup)))?.alertOn).toEqual({ priceBelow: { amount: 25000, currency: "GBP" } });
    expect((await t.run((ctx) => ctx.db.get(plainGroup)))?.alertOn).toEqual({ priceDrop: true, backInStock: true });
  });

  // "$" alone could be US, Canadian, Australian or New Zealand dollars.
  it("settles a dollar target from the page's currency", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    const id = await seedMonitor(t, userId, {
      prompt: "tell me when it's under $200",
      lastSeen: { price: 24900, currency: "USD" },
    });
    const groupId = await as.mutation(api.monitorGroups.convertMonitor, { monitorId: id });
    expect((await t.run((ctx) => ctx.db.get(groupId)))?.alertOn).toEqual({ priceBelow: { amount: 20000, currency: "USD" } });
  });

  // The product read never compares a target with a price in another currency,
  // so such a target could never fire.
  it("drops a target in another currency than the page's", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    const id = await seedMonitor(t, userId, { prompt: "tell me when it's under £200", lastSeen: { price: 24900, currency: "USD" } });
    const groupId = await as.mutation(api.monitorGroups.convertMonitor, { monitorId: id });
    expect((await t.run((ctx) => ctx.db.get(groupId)))?.alertOn).toEqual({ priceDrop: true, backInStock: true });
  });

  // Converting is one way, so the user sees what the alerts become first.
  it("previews the alerts and the prompt it replaces, changing nothing", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    const id = await seedMonitor(t, userId);
    expect(await as.query(api.monitorGroups.conversionPreview, { monitorId: id })).toEqual({
      alertOn: { backInStock: true },
      oldPrompt: "tell me when it is back in stock",
    });
    expect(await t.run((ctx) => ctx.db.query("monitorGroups").collect())).toHaveLength(0);
  });

  // The store search runs straight after. Converting with none left would
  // leave a one-shop product and no way back.
  it("refuses when no store searches are left today", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    const id = await seedMonitor(t, userId);
    await t.run((ctx) =>
      ctx.db.insert("userTiers", {
        userId,
        tier: "free",
        productSearchDay: new Date().toISOString().slice(0, 10),
        productSearchCount: 5,
        updatedAt: 0,
      })
    );
    await expect(as.mutation(api.monitorGroups.convertMonitor, { monitorId: id })).rejects.toThrow(/searches/);
    expect((await t.run((ctx) => ctx.db.get(id)))?.groupId).toBeUndefined();
  });

  // The same refusals as the search itself, or the search can still refuse after.
  it("refuses when the search would refuse for too many attempts", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    const id = await seedMonitor(t, userId);
    await t.run((ctx) =>
      ctx.db.insert("userTiers", {
        userId,
        tier: "free",
        productSearchDay: new Date().toISOString().slice(0, 10),
        productSearchCount: 2,
        // The free ceiling: max(10, 3 × 5 searches).
        productSearchAttempts: 15,
        updatedAt: 0,
      })
    );
    await expect(as.mutation(api.monitorGroups.convertMonitor, { monitorId: id })).rejects.toThrow(/isn't working/);
  });

  it("is offered only for a product page of the user's own that is not in a product yet", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, "a@example.test");
    const listPage = await seedMonitor(t, userId, {
      schema: { items: [{ title: "A", url: "https://www.argos.co.uk/a" }, { title: "B", url: "https://www.argos.co.uk/b" }] },
    });
    const product = await seedMonitor(t, userId);
    const theirs = await seedMonitor(t, "someone-else");

    expect(await as.query(api.monitorGroups.conversionPreview, { monitorId: listPage })).toEqual({
      refusal: "Only a page showing one product can become a product.",
    });

    await expect(as.mutation(api.monitorGroups.convertMonitor, { monitorId: listPage })).rejects.toThrow(/one product/);
    await expect(as.mutation(api.monitorGroups.convertMonitor, { monitorId: theirs })).rejects.toThrow(/not found/);
    await as.mutation(api.monitorGroups.convertMonitor, { monitorId: product });
    await expect(as.mutation(api.monitorGroups.convertMonitor, { monitorId: product })).rejects.toThrow(/already/);
    expect(await t.run((ctx) => ctx.db.query("monitorGroups").collect())).toHaveLength(1);
  });
});
