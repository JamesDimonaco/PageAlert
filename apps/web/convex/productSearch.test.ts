/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, components } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import betterAuthSchema from "./betterAuth/schema";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

async function signUp(t: ReturnType<typeof harness>, betaOn = true, email = "a@example.test") {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: { name: "A Person", email, emailVerified: true, createdAt: 0, updatedAt: 0 },
    },
  })) as { _id: string };
  const as = t.withIdentity({ subject: user._id });
  if (betaOn) await as.mutation(api.betaFeatures.set, { feature: "find_a_product", enabled: true });
  return { as, userId: user._id };
}

const LISTING = {
  site: "argos.co.uk",
  url: "https://www.argos.co.uk/product/1",
  title: "Sony WH-1000XM5",
  price: 27999,
  currency: "GBP",
  inStock: true,
  label: "same",
};

function scraperReturns(response: () => Response) {
  const fetchMock = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const found = () => new Response(JSON.stringify({ listings: [LISTING] }), { status: 200 });
const SEARCH = { query: "Sony WH-1000XM5", region: "GB" };

beforeEach(() => {
  vi.stubEnv("SCRAPER_URL", "https://scraper.test");
  vi.stubEnv("SCRAPER_API_KEY", "key");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// Every search is a paid web-search call. A broken cap spends money without
// limit; a missing refund charges users for searches that gave them nothing.
describe("productSearch.search", () => {
  it("refuses a user with the beta off, without calling the scraper", async () => {
    const t = harness();
    const { as: user } = await signUp(t, false);
    const fetchMock = scraperReturns(found);

    await expect(user.action(api.productSearch.search, SEARCH)).rejects.toThrow("beta feature");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops a free user at 5 a day", async () => {
    const t = harness();
    const { as: user } = await signUp(t);
    const fetchMock = scraperReturns(found);

    for (let i = 0; i < 5; i++) {
      expect(await user.action(api.productSearch.search, SEARCH)).toHaveLength(1);
    }
    expect((await user.query(api.productSearch.status, {}))?.used).toBe(5);
    await expect(user.action(api.productSearch.search, SEARCH)).rejects.toThrow("all 5 searches");
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("does not count a search that failed", async () => {
    const t = harness();
    const { as: user } = await signUp(t);
    scraperReturns(() => new Response("{}", { status: 500 }));

    await expect(user.action(api.productSearch.search, SEARCH)).rejects.toThrow("hasn't counted");
    expect((await user.query(api.productSearch.status, {}))?.used).toBe(0);
  });

  // Today's prod failure only showed "HTTP 500" in the logs. The scraper's reason must reach PostHog.
  it("reports why a search failed", async () => {
    const t = harness();
    const { as: user, userId } = await signUp(t);
    scraperReturns(() => new Response(JSON.stringify({ error: "search_failed", reason: "no_json" }), { status: 500 }));

    await expect(user.action(api.productSearch.search, SEARCH)).rejects.toThrow("hasn't counted");
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const failed = scheduled.find((job) => (job.args[0] as { event?: string }).event === "product_search_failed");
    expect(failed?.args[0]).toMatchObject({ distinctId: userId, properties: { reason: "no_json", region: "GB" } });
  });

  it("does not count a search that found nothing", async () => {
    const t = harness();
    const { as: user } = await signUp(t);
    scraperReturns(() => new Response(JSON.stringify({ listings: [] }), { status: 200 }));

    expect(await user.action(api.productSearch.search, SEARCH)).toEqual([]);
    expect((await user.query(api.productSearch.status, {}))?.used).toBe(0);
  });

  it("refunds a 200 whose body is not listings", async () => {
    const t = harness();
    const { as: user } = await signUp(t);
    scraperReturns(() => new Response(JSON.stringify({ listings: [{ url: 1 }] }), { status: 200 }));

    await expect(user.action(api.productSearch.search, SEARCH)).rejects.toThrow("hasn't counted");
    expect((await user.query(api.productSearch.status, {}))?.used).toBe(0);
  });

  it("stops retries at a hidden ceiling even though failures are refunded", async () => {
    const t = harness();
    const { as: user } = await signUp(t);
    const fetchMock = scraperReturns(() => new Response("{}", { status: 500 }));

    // Free is 5 a day, so the ceiling is 3 x 5 = 15 paid calls.
    for (let i = 0; i < 15; i++) {
      await expect(user.action(api.productSearch.search, SEARCH)).rejects.toThrow("hasn't counted");
    }
    await expect(user.action(api.productSearch.search, SEARCH)).rejects.toThrow("isn't working for you today");
    expect(fetchMock).toHaveBeenCalledTimes(15);
    expect((await user.query(api.productSearch.status, {}))?.used).toBe(0);
  });

  it("saves the region as the user's default", async () => {
    const t = harness();
    const { as: user } = await signUp(t);
    scraperReturns(found);

    await user.action(api.productSearch.search, { ...SEARCH, region: "DE" });
    expect((await user.query(api.productSearch.status, {}))?.region).toBe("DE");
  });
});

type GroupListing = Doc<"monitorGroups">["listings"][number];

const stored = (url: string, state: GroupListing["state"]): GroupListing => ({
  site: new URL(url).hostname,
  url,
  title: "Sony WH-1000XM5",
  label: "same",
  state,
});

function insertProduct(t: ReturnType<typeof harness>, userId: string, listings: GroupListing[]) {
  return t.run((ctx) =>
    ctx.db.insert("monitorGroups", {
      userId,
      name: "Sony WH-1000XM5",
      region: "GB",
      alertOn: { backInStock: true },
      checkInterval: "1h",
      listings,
      createdAt: 0,
      updatedAt: 0,
    })
  );
}

const foundAt =
  (...urls: string[]) =>
  () =>
    new Response(JSON.stringify({ listings: urls.map((url) => ({ ...LISTING, site: new URL(url).hostname, url })) }), {
      status: 200,
    });

const listingsOf = (t: ReturnType<typeof harness>, id: Id<"monitorGroups">) =>
  t.run(async (ctx) => (await ctx.db.get(id))?.listings ?? []);

// A repeated suggestion clutters the product and can be watched twice, so the
// user pays two monitor slots for one page. A lost search costs the user, and
// someone else's product must not be searched or changed.
describe("productSearch.findMore", () => {
  it("adds new results as suggestions and skips ones already in the product, in any state", async () => {
    const t = harness();
    const { as, userId } = await signUp(t);
    const id = await insertProduct(t, userId, [
      stored("https://argos.co.uk/a", "watching"),
      stored("https://currys.co.uk/b", "suggested"),
      stored("https://johnlewis.com/c", "dismissed"),
    ]);
    const fetchMock = scraperReturns(
      foundAt(
        // Tracking parameters and www. don't make a known page new.
        "https://www.argos.co.uk/a?utm_source=x",
        "https://currys.co.uk/b",
        "https://johnlewis.com/c",
        // A different page on a site the product already has is new.
        "https://argos.co.uk/other",
        "https://ao.com/d"
      )
    );

    const result = await as.action(api.productSearch.findMore, { groupId: id });

    expect(result).toEqual({ added: ["https://argos.co.uk/other", "https://ao.com/d"], full: false });
    expect((await listingsOf(t, id)).map((l) => [l.url, l.state])).toEqual([
      ["https://argos.co.uk/a", "watching"],
      ["https://currys.co.uk/b", "suggested"],
      ["https://johnlewis.com/c", "dismissed"],
      ["https://argos.co.uk/other", "suggested"],
      ["https://ao.com/d", "suggested"],
    ]);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ query: "Sony WH-1000XM5", region: "GB" });
    expect((await as.query(api.productSearch.status, {}))?.used).toBe(1);
  });

  it("does not store accessories", async () => {
    const t = harness();
    const { as, userId } = await signUp(t);
    const id = await insertProduct(t, userId, [stored("https://argos.co.uk/a", "watching")]);
    scraperReturns(
      () =>
        new Response(JSON.stringify({ listings: [{ ...LISTING, url: "https://ao.com/case", label: "accessory" }] }), {
          status: 200,
        })
    );

    expect(await as.action(api.productSearch.findMore, { groupId: id })).toEqual({ added: [], full: false });
    expect(await listingsOf(t, id)).toHaveLength(1);
  });

  it("does not count a search that failed, and adds nothing", async () => {
    const t = harness();
    const { as, userId } = await signUp(t);
    const id = await insertProduct(t, userId, [stored("https://argos.co.uk/a", "watching")]);
    scraperReturns(() => new Response("{}", { status: 500 }));

    await expect(as.action(api.productSearch.findMore, { groupId: id })).rejects.toThrow("hasn't counted");
    expect((await as.query(api.productSearch.status, {}))?.used).toBe(0);
    expect(await listingsOf(t, id)).toHaveLength(1);
  });

  it("refuses someone else's product without searching", async () => {
    const t = harness();
    const { userId: owner } = await signUp(t);
    const { as: other } = await signUp(t, true, "b@example.test");
    const id = await insertProduct(t, owner, [stored("https://argos.co.uk/a", "watching")]);
    const fetchMock = scraperReturns(foundAt("https://ao.com/d"));

    await expect(other.action(api.productSearch.findMore, { groupId: id })).rejects.toThrow("Product not found");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await listingsOf(t, id)).toHaveLength(1);
  });

  it("refuses a user with the beta off", async () => {
    const t = harness();
    const { as, userId } = await signUp(t, false);
    const id = await insertProduct(t, userId, [stored("https://argos.co.uk/a", "watching")]);
    const fetchMock = scraperReturns(foundAt("https://ao.com/d"));

    await expect(as.action(api.productSearch.findMore, { groupId: id })).rejects.toThrow("beta feature");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fills a product up to 24 listings and says when some didn't fit", async () => {
    const t = harness();
    const { as, userId } = await signUp(t);
    const existing = Array.from({ length: 22 }, (_, i) => stored(`https://shop${i}.test/x`, "dismissed"));
    const id = await insertProduct(t, userId, existing);
    scraperReturns(foundAt("https://ao.com/1", "https://ao.com/2", "https://ao.com/3"));

    expect(await as.action(api.productSearch.findMore, { groupId: id })).toEqual({
      added: ["https://ao.com/1", "https://ao.com/2"],
      full: true,
    });
    expect(await listingsOf(t, id)).toHaveLength(24);
  });

  it("gives the search back when the product filled up during it", async () => {
    const t = harness();
    const { as, userId } = await signUp(t);
    const id = await insertProduct(t, userId, [stored("https://argos.co.uk/a", "watching")]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const filled = Array.from({ length: 24 }, (_, i) => stored(`https://shop${i}.test/x`, "dismissed"));
        await t.run((ctx) => ctx.db.patch(id, { listings: filled }));
        return foundAt("https://ao.com/1")();
      })
    );

    expect(await as.action(api.productSearch.findMore, { groupId: id })).toEqual({ added: [], full: true });
    expect((await as.query(api.productSearch.status, {}))?.used).toBe(0);
  });

  it("gives the search back when the product was deleted during it", async () => {
    const t = harness();
    const { as, userId } = await signUp(t);
    const id = await insertProduct(t, userId, [stored("https://argos.co.uk/a", "watching")]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await t.run((ctx) => ctx.db.delete(id));
        return foundAt("https://ao.com/1")();
      })
    );

    expect(await as.action(api.productSearch.findMore, { groupId: id })).toEqual({ added: [], full: false });
    expect((await as.query(api.productSearch.status, {}))?.used).toBe(0);
  });

  it("keeps the user's own default region", async () => {
    const t = harness();
    const { as, userId } = await signUp(t);
    scraperReturns(foundAt("https://ao.com/1"));
    await as.action(api.productSearch.search, { ...SEARCH, region: "DE" });
    const id = await insertProduct(t, userId, [stored("https://argos.co.uk/a", "watching")]);

    await as.action(api.productSearch.findMore, { groupId: id });
    expect((await as.query(api.productSearch.status, {}))?.region).toBe("DE");
  });

  it("refuses a product whose name can't be searched, without spending a search", async () => {
    const t = harness();
    const { as, userId } = await signUp(t);
    const id = await insertProduct(t, userId, [stored("https://argos.co.uk/a", "watching")]);
    await t.run((ctx) => ctx.db.patch(id, { name: "X" }));
    const fetchMock = scraperReturns(foundAt("https://ao.com/1"));

    await expect(as.action(api.productSearch.findMore, { groupId: id })).rejects.toThrow("Type a product name");
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await as.query(api.productSearch.status, {}))?.used).toBe(0);
  });

  it("refuses a full product without spending a search", async () => {
    const t = harness();
    const { as, userId } = await signUp(t);
    const existing = Array.from({ length: 24 }, (_, i) => stored(`https://shop${i}.test/x`, "dismissed"));
    const id = await insertProduct(t, userId, existing);
    const fetchMock = scraperReturns(foundAt("https://ao.com/1"));

    await expect(as.action(api.productSearch.findMore, { groupId: id })).rejects.toThrow("the most it can hold");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
