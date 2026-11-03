/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, components } from "./_generated/api";
import schema from "./schema";
import betterAuthSchema from "./betterAuth/schema";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

async function signUp(t: ReturnType<typeof harness>, betaOn = true) {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: { name: "A Person", email: "a@example.test", emailVerified: true, createdAt: 0, updatedAt: 0 },
    },
  })) as { _id: string };
  const as = t.withIdentity({ subject: user._id });
  if (betaOn) await as.mutation(api.betaFeatures.set, { feature: "find_a_product", enabled: true });
  return as;
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
    const user = await signUp(t, false);
    const fetchMock = scraperReturns(found);

    await expect(user.action(api.productSearch.search, SEARCH)).rejects.toThrow("beta feature");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops a free user at 5 a day", async () => {
    const t = harness();
    const user = await signUp(t);
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
    const user = await signUp(t);
    scraperReturns(() => new Response("{}", { status: 500 }));

    await expect(user.action(api.productSearch.search, SEARCH)).rejects.toThrow("hasn't counted");
    expect((await user.query(api.productSearch.status, {}))?.used).toBe(0);
  });

  it("does not count a search that found nothing", async () => {
    const t = harness();
    const user = await signUp(t);
    scraperReturns(() => new Response(JSON.stringify({ listings: [] }), { status: 200 }));

    expect(await user.action(api.productSearch.search, SEARCH)).toEqual([]);
    expect((await user.query(api.productSearch.status, {}))?.used).toBe(0);
  });

  it("refunds a 200 whose body is not listings", async () => {
    const t = harness();
    const user = await signUp(t);
    scraperReturns(() => new Response(JSON.stringify({ listings: [{ url: 1 }] }), { status: 200 }));

    await expect(user.action(api.productSearch.search, SEARCH)).rejects.toThrow("hasn't counted");
    expect((await user.query(api.productSearch.status, {}))?.used).toBe(0);
  });

  it("stops retries at a hidden ceiling even though failures are refunded", async () => {
    const t = harness();
    const user = await signUp(t);
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
    const user = await signUp(t);
    scraperReturns(found);

    await user.action(api.productSearch.search, { ...SEARCH, region: "DE" });
    expect((await user.query(api.productSearch.status, {}))?.region).toBe("DE");
  });
});
