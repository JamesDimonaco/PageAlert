/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

let sent: { html: string; text: string }[];

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test");
  sent = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ id: "re_1" });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

const MATCH = {
  to: "a@example.com",
  monitorName: "Switch 2",
  monitorId: "m_1",
  url: "https://shop.test/switch",
  matchCount: 1,
  matches: [{ title: "Switch 2", url: "https://shop.test/switch", price: 395 }],
  totalItems: 4,
};

async function shownEvents(t: ReturnType<typeof setup>) {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs
    .map((j) => j.args[0] as { event?: string; properties?: Record<string, string> })
    .filter((a) => a.event === "upgrade_prompt_shown")
    .map((a) => a.properties);
}

// A match is the moment a free user learns an hourly check can be too late.
// The link carries its placement, so a sale can be traced back to the email.
test("a free user's match email offers the Sprint pass and records that it was shown", async () => {
  const t = setup();
  await t.action(internal.emails.sendMatchAlert, { ...MATCH, offerSprintTo: "user_1" });
  expect(sent[0]?.html).toContain("/dashboard/settings?tab=billing&amp;from=match_email");
  expect(sent[0]?.text).toContain("/dashboard/settings?tab=billing&from=match_email");
  expect(await shownEvents(t)).toEqual([{ placement: "match_email", current_tier: "free", target_plan: "sprint" }]);
});

test("a match email without the offer carries no Sprint pitch", async () => {
  const t = setup();
  await t.action(internal.emails.sendMatchAlert, MATCH);
  expect(sent[0]?.html).not.toContain("from=match_email");
  expect(sent[0]?.text).not.toContain("Sprint");
  expect(await shownEvents(t)).toEqual([]);
});

// "Shown" must mean the person got the email, or the placement comparison lies.
test("a match email that fails to send records no Sprint offer", async () => {
  vi.stubGlobal("fetch", async () => new Response("rate limited", { status: 429 }));
  const t = setup();
  await t.action(internal.emails.sendMatchAlert, { ...MATCH, offerSprintTo: "user_1" });
  expect(await shownEvents(t)).toEqual([]);
});
