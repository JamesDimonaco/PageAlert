/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.*s");

afterEach(() => vi.unstubAllGlobals());

// The stock note carries a title read off a shop's page. Rendered as markdown,
// a page could plant a link in the user's Discord.
test("page text in a Discord alert cannot become a link", async () => {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body));
    return new Response(null, { status: 204 });
  });
  const t = convexTest(schema, modules);
  await t.action(internal.discord.sendMatchAlert, {
    webhookUrl: "https://discord.com/api/webhooks/1/abc",
    monitorName: "RAM",
    monitorId: "m1",
    url: "https://shop.test",
    matchCount: 1,
    totalItems: 9,
    stockNote: "Stock not shown on page for “[Claim prize](https://evil.test) @everyone”.",
  });
  const description: string = JSON.parse(bodies[0]!).embeds[0].description;
  expect(description).toContain("Claim prize");
  expect(description).not.toMatch(/\]\(|@everyone/);
});
