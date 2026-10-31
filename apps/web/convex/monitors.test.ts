/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { api, components } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

async function seedUser(t: ReturnType<typeof setup>, email: string) {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: { model: "user", data: { name: "A Person", email, emailVerified: true, createdAt: Date.now(), updatedAt: Date.now() } },
  })) as { _id: string };
  return t.withIdentity({ subject: user._id, email });
}

const MONITOR = { url: "https://example.com/huts", prompt: "any Feb start date", name: "Milford", checkInterval: "24h" as const };

// Each claim is a paid Scrapfly call, and the route fetches whatever URL comes
// back, so a claim that can repeat or reach another user's monitor is a way to
// spend our credit on any page.
test("a first-scan proxy claim is once only, for the owner, on the monitor's own URL", async () => {
  const t = setup();
  const owner = await seedUser(t, "a@example.com");
  const stranger = await seedUser(t, "b@example.com");
  const id = await owner.mutation(api.monitors.create, MONITOR);

  await expect(stranger.mutation(api.monitors.claimFirstScanProxy, { id })).rejects.toThrow();
  expect(await owner.mutation(api.monitors.claimFirstScanProxy, { id })).toBe(MONITOR.url);
  expect(await owner.mutation(api.monitors.claimFirstScanProxy, { id })).toBeNull();

  const calls = await t.run((ctx) =>
    ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", `fallback:calls:${new Date().toISOString().slice(0, 7)}`)).unique()
  );
  expect(calls?.value).toBe(1);
});

// A claim is not proof the proxy works. Marking the site proxy-preferred on the
// claim alone would floor the user's interval at 6h even when the proxy failed.
test("only a first scan that got in through the proxy makes the site proxy-preferred", async () => {
  const t = setup();
  const owner = await seedUser(t, "a@example.com");
  const id = await owner.mutation(api.monitors.create, MONITOR);
  await owner.mutation(api.monitors.claimFirstScanProxy, { id });
  expect((await t.run((ctx) => ctx.db.get(id)))?.proxyPreferred).toBeUndefined();

  await owner.mutation(api.monitors.saveScanResult, { id, schema: { items: [] }, matchCount: 0, usedProxy: true });
  expect((await t.run((ctx) => ctx.db.get(id)))?.proxyPreferred).toBe(true);
});

// The claimed proxy attempt can fail and the direct one then work. Marking the
// site proxy-preferred then would put every later check through the proxy.
test("a direct first scan after a claim does not make the site proxy-preferred", async () => {
  const t = setup();
  const owner = await seedUser(t, "a@example.com");
  const id = await owner.mutation(api.monitors.create, MONITOR);
  await owner.mutation(api.monitors.claimFirstScanProxy, { id });
  await owner.mutation(api.monitors.saveScanResult, { id, schema: { items: [] }, matchCount: 0 });
  expect((await t.run((ctx) => ctx.db.get(id)))?.proxyPreferred).toBeUndefined();
});

// Skipping the direct scan spends credit before anything has failed, so it has
// to rest on evidence: a live monitor on the same site that needs the proxy.
test("a first scan goes straight to the proxy only on a site a live monitor already needs it for", async () => {
  const t = setup();
  const owner = await seedUser(t, "a@example.com");
  const first = await owner.mutation(api.monitors.create, MONITOR);
  const second = await owner.mutation(api.monitors.create, { ...MONITOR, url: "https://www.example.com/other" });
  expect(await owner.mutation(api.monitors.claimFirstScanProxy, { id: second, knownHost: true })).toBeNull();

  await t.run((ctx) => ctx.db.patch(first, { status: "active", proxyPreferred: true }));
  expect(await owner.mutation(api.monitors.claimFirstScanProxy, { id: second, knownHost: true })).toBe(
    "https://www.example.com/other"
  );

  await t.run((ctx) => ctx.db.patch(first, { status: "paused" }));
  const third = await owner.mutation(api.monitors.create, { ...MONITOR, url: "https://example.com/third" });
  expect(await owner.mutation(api.monitors.claimFirstScanProxy, { id: third, knownHost: true })).toBeNull();
});

test("no proxy claim once the first scan has finished", async () => {
  const t = setup();
  const owner = await seedUser(t, "a@example.com");
  const id = await owner.mutation(api.monitors.create, MONITOR);
  await owner.mutation(api.monitors.saveScanResult, { id, schema: { items: [] }, matchCount: 0 });

  expect(await owner.mutation(api.monitors.claimFirstScanProxy, { id })).toBeNull();
});
