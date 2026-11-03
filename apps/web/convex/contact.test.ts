/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, components } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 10, 3, 12) }));
afterEach(() => vi.useRealTimers());

async function signedIn(email: string) {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: { model: "user", data: { name: "A Person", email, emailVerified: true, createdAt: Date.now(), updatedAt: Date.now() } },
  })) as { _id: string };
  return { t, user: t.withIdentity({ subject: user._id, email }) };
}

async function sentTexts(t: Awaited<ReturnType<typeof signedIn>>["t"]): Promise<string[]> {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs.filter((j) => j.name === "admin:notify").map((j) => (j.args[0] as { text: string }).text);
}

// Every message pings James's phone, so one person must not be able to flood it.
test("one message a minute per user, each naming who sent it", async () => {
  const { t, user } = await signedIn("someone@example.com");
  const msg = { kind: "bug" as const, message: "The save button does nothing", page: "/dashboard" };

  await user.mutation(api.contact.send, msg);
  await expect(user.mutation(api.contact.send, msg)).rejects.toThrow(/Try again in a minute/);

  vi.advanceTimersByTime(60_000);
  await user.mutation(api.contact.send, msg);

  const texts = await sentTexts(t);
  expect(texts).toHaveLength(2);
  expect(texts[0]).toContain("someone@example.com");
  expect(texts[0]).toContain("The save button does nothing");
});

// The privacy page says feedback is not stored in PageAlert, so the one row it leaves goes with the account.
test("deleting the account removes the feedback rate-limit row", async () => {
  const { t, user } = await signedIn("leaver@example.com");
  await user.mutation(api.contact.send, { kind: "idea", message: "Dark mode", page: "/dashboard" });
  await user.mutation(api.account.deleteAccount, {});

  const counters = await t.run((ctx) => ctx.db.query("counters").collect());
  expect(counters.filter((c) => c.name.startsWith("contact:"))).toEqual([]);
});
