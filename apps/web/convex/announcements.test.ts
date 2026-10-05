/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import schema from "./schema";
import betterAuthSchema from "./betterAuth/schema";
import { components, internal } from "./_generated/api";
import { ANNOUNCEMENT_BATCH_SIZE } from "./announcements";
import { verifyUnsubscribeToken } from "./unsubscribe";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

const KEY = "sms-alerts-2026-10";
const NOW = 1_700_000_000_000;

type Payload = { to: string[]; subject: string; html: string; text: string; headers: Record<string, string> };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv("UNSUBSCRIBE_SECRET", "test-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("ADMIN_EMAIL", "admin@example.com");
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
    const sent = JSON.parse(init.body) as Payload[];
    return new Response(JSON.stringify({ data: sent.map((_, i) => ({ id: `re_${i}` })) }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}
type T = ReturnType<typeof harness>;

async function seedUser(t: T, email: string | null): Promise<string> {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: { name: "A Person", email: email ?? "", emailVerified: true, createdAt: NOW, updatedAt: NOW },
    },
  })) as { _id: string };
  return user._id;
}

function sentPayloads(): Payload[] {
  return fetchMock.mock.calls.flatMap(([, init]) => JSON.parse((init as { body: string }).body) as Payload[]);
}

describe("announcements.send", () => {
  it("dry run is the default, sends nothing, records nothing, and counts who would get it", async () => {
    const t = harness();
    await seedUser(t, "a@example.com");
    await seedUser(t, "b@example.com");

    const result = await t.action(internal.announcements.send, { key: KEY });

    expect(result).toMatchObject({ dryRun: true, wouldSend: 2 });
    expect(fetchMock).not.toHaveBeenCalled();
    const rows = await t.run((ctx) => ctx.db.query("announcementSends").collect());
    expect(rows).toHaveLength(0);
  });

  it("skips opted-out users and users with no email, in the dry run and the real one", async () => {
    const t = harness();
    await seedUser(t, "keep@example.com");
    const gone = await seedUser(t, "gone@example.com");
    await seedUser(t, null);
    await t.run((ctx) => ctx.db.insert("productUpdateOptOuts", { userId: gone, optedOutAt: NOW }));

    const dry = await t.action(internal.announcements.send, { key: KEY, dryRun: true });
    expect(dry).toMatchObject({ wouldSend: 1 });

    await t.action(internal.announcements.send, { key: KEY, dryRun: false });
    expect(sentPayloads().map((p) => p.to)).toEqual([["keep@example.com"]]);
  });

  it("gives each recipient their own working one-click unsubscribe link and headers", async () => {
    const t = harness();
    const a = await seedUser(t, "a@example.com");
    const b = await seedUser(t, "b@example.com");

    await t.action(internal.announcements.send, { key: KEY, dryRun: false });

    const payloads = sentPayloads();
    expect(payloads).toHaveLength(2);
    for (const [userId, email] of [
      [a, "a@example.com"],
      [b, "b@example.com"],
    ]) {
      const p = payloads.find((x) => x.to[0] === email)!;
      const header = p.headers["List-Unsubscribe"];
      const url = new URL(header.slice(1, -1));
      expect(url.origin + url.pathname).toBe("https://example.convex.site/unsubscribe");
      expect(url.searchParams.get("u")).toBe(userId);
      expect(await verifyUnsubscribeToken(userId, url.searchParams.get("t") ?? "")).toBe(true);
      expect(p.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
      expect(p.html).toContain("/unsubscribe?u=");
      expect(p.text).toContain("/unsubscribe?u=");
    }
  });

  it("does not send twice when run again", async () => {
    const t = harness();
    await seedUser(t, "a@example.com");

    await t.action(internal.announcements.send, { key: KEY, dryRun: false });
    const second = await t.action(internal.announcements.send, { key: KEY, dryRun: false });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ sent: 0 });
  });

  it("retries only the users whose send failed", async () => {
    const t = harness();
    await seedUser(t, "a@example.com");
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));

    const first = await t.action(internal.announcements.send, { key: KEY, dryRun: false });
    expect(first).toMatchObject({ sent: 0, failed: 1 });

    const second = await t.action(internal.announcements.send, { key: KEY, dryRun: false });
    expect(second).toMatchObject({ sent: 1, failed: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an unknown announcement key", async () => {
    const t = harness();
    await seedUser(t, "a@example.com");
    await t.action(internal.announcements.send, { key: KEY, dryRun: false });
    const other = await t.action(internal.announcements.send, { key: "not-a-real-key", dryRun: true }).catch((e) => e);
    expect(String(other)).toMatch(/Unknown announcement/);
  });

  it("pages through more users than one batch holds, and each Resend call stays within the batch limit", async () => {
    const t = harness();
    const total = ANNOUNCEMENT_BATCH_SIZE + 5;
    for (let i = 0; i < total; i++) await seedUser(t, `u${i}@example.com`);

    const result = await t.action(internal.announcements.send, { key: KEY, dryRun: false });

    expect(result).toMatchObject({ sent: total });
    expect(sentPayloads()).toHaveLength(total);
    for (const [, init] of fetchMock.mock.calls) {
      expect((JSON.parse((init as { body: string }).body) as unknown[]).length).toBeLessThanOrEqual(100);
    }
  });

  it("pins the batch size to Resend's batch maximum", () => {
    expect(ANNOUNCEMENT_BATCH_SIZE).toBe(100);
  });
});
