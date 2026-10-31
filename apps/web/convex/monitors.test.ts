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

test("no proxy claim once the first scan has finished", async () => {
  const t = setup();
  const owner = await seedUser(t, "a@example.com");
  const id = await owner.mutation(api.monitors.create, MONITOR);
  await owner.mutation(api.monitors.saveScanResult, { id, schema: { items: [] }, matchCount: 0 });

  expect(await owner.mutation(api.monitors.claimFirstScanProxy, { id })).toBeNull();
});
