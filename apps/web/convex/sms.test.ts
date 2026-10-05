/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, components, internal } from "./_generated/api";
import schema from "./schema";
import betterAuthSchema from "./betterAuth/schema";
import { twilioSignature } from "./sms";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

const NOW = 1_700_000_000_000;

function verification(userId: string, expiresAt: number) {
  return {
    userId,
    phone: `+4479111${userId.slice(-5)}`,
    code: "481920",
    expiresAt,
    attempts: 0,
  };
}

/**
 * A verification row holds a raw phone number. It dies on a confirmed code, on
 * a later failed one, or on releaseVerification — but a code requested and
 * never entered has none of those happen to it, so without this sweep the
 * number sits there for good. The privacy page says a code you do not finish
 * is deleted after it expires, which is only true because of this.
 */
/**
 * The cap /sms-policy promises carriers: "An account may request at most 3
 * codes per day." A counter living on the verification row cannot deliver
 * that, because every terminal path deletes the row — a confirmed code, an
 * expired one, five wrong guesses, and the hourly sweep. Each one hands the
 * account a fresh three.
 */
describe("claimVerification daily cap", () => {
  async function claim(t: ReturnType<typeof convexTest>) {
    return t.mutation(internal.sms.claimVerification, {
      userId: "user-capped",
      phone: "+447911123456",
    });
  }

  it("counts codes for the day even when the pending row is gone", async () => {
    const t = convexTest(schema, modules);

    for (let i = 0; i < 3; i++) await claim(t);
    await expect(claim(t)).rejects.toThrow(/3 codes today/);

    // What a confirmed code, an expired one, or the sweep all leave behind.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("phoneVerifications")
        .withIndex("by_userId", (q) => q.eq("userId", "user-capped"))
        .unique();
      if (row) await ctx.db.delete(row._id);
    });

    await expect(claim(t)).rejects.toThrow(/3 codes today/);
  });

  it("does not let one account's codes count against another's", async () => {
    const t = convexTest(schema, modules);

    for (let i = 0; i < 3; i++) await claim(t);
    await expect(
      t.mutation(internal.sms.claimVerification, { userId: "user-other", phone: "+447911999888" })
    ).resolves.toMatch(/^\d{6}$/);
  });
});

describe("expireVerifications", () => {
  it("deletes rows past their expiry and leaves live ones alone", async () => {
    const t = convexTest(schema, modules);

    const { stale, live } = await t.run(async (ctx) => ({
      stale: await ctx.db.insert("phoneVerifications", verification("user-stale", NOW - 60_000)),
      live: await ctx.db.insert("phoneVerifications", verification("user-live", NOW + 600_000)),
    }));

    await t.mutation(internal.sms.expireVerifications, { now: NOW });

    await t.run(async (ctx) => {
      expect(await ctx.db.get(stale), "an expired verification survived the sweep").toBeNull();
      expect(await ctx.db.get(live), "a live verification was swept").not.toBeNull();
    });
  });

  it("sweeps a row left with a zero expiry", async () => {
    // Nothing writes expiresAt: 0 today — releaseVerification deletes the row
    // outright — but rows written before that change carry it, and a zero read
    // as "no expiry" rather than "long expired" would strand the number.
    const t = convexTest(schema, modules);

    const released = await t.run((ctx) =>
      ctx.db.insert("phoneVerifications", verification("user-released", 0))
    );

    await t.mutation(internal.sms.expireVerifications, { now: NOW });

    await t.run(async (ctx) => {
      expect(await ctx.db.get(released), "a released verification kept the number").toBeNull();
    });
  });
});

// ---- Failure alerts ----

const SITE = "https://example-123.convex.site";
const AUTH_TOKEN = "twilio-auth-token";
const PHONE = "+447911123456";

function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

type AnyTest = ReturnType<typeof setup>;

/** The texts the admin was sent, whatever became of the Telegram call. */
async function adminAlerts(t: AnyTest): Promise<string[]> {
  return t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs
      .filter((job) => job.name === "admin:notify")
      .map((job) => (job.args as [{ text: string }])[0].text);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("TWILIO_AUTH_TOKEN", AUTH_TOKEN);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("twilioSignature", () => {
  it("matches the worked example in Twilio's security docs", async () => {
    // Pins the algorithm: URL, then each param as name+value in name order,
    // HMAC-SHA1, base64. Reordering or re-delimiting breaks every real callback.
    const sig = await twilioSignature(
      "12345",
      "https://example.com/myapp.php?foo=1&bar=2",
      new URLSearchParams({
        Digits: "1234",
        To: "+18005551212",
        From: "+14158675310",
        Caller: "+14158675310",
        CallSid: "CA1234567890ABCDE",
      }),
    );
    expect(sig).toBe("L/OH5YylLD5NRKLltdqwSvS0BnU=");
  });
});

describe("failed sends", () => {
  async function sendWithTwilioError(t: AnyTest, status: number, code: number) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ code, message: `bad number ${PHONE}` }), { status })),
    );
    vi.stubEnv("SMS_ENABLED", "true");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG123");
    await expect(
      t.action(internal.sms.sendMatchAlert, {
        userId: "user-sms",
        phone: PHONE,
        monitorName: "Huts",
        monitorId: "m1",
        matchCount: 1,
      }),
    ).rejects.toThrow();
  }

  it("tells the admin the Twilio code and status, without the full number", async () => {
    const t = setup();
    await sendWithTwilioError(t, 401, 20003);

    const alerts = await adminAlerts(t);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("20003");
    expect(alerts[0]).toContain("401");
    expect(alerts[0]).toContain("3456");
    expect(alerts[0]).not.toContain("7911123456");
  });

  it("alerts once per error code per hour, and again for a different code", async () => {
    const t = setup();
    await sendWithTwilioError(t, 401, 20003);
    await sendWithTwilioError(t, 401, 20003);
    expect(await adminAlerts(t)).toHaveLength(1);

    await sendWithTwilioError(t, 400, 21606);
    expect(await adminAlerts(t)).toHaveLength(2);

    vi.advanceTimersByTime(60 * 60 * 1000 - 1);
    await sendWithTwilioError(t, 401, 20003);
    expect(await adminAlerts(t)).toHaveLength(2);

    vi.advanceTimersByTime(2);
    await sendWithTwilioError(t, 401, 20003);
    expect(await adminAlerts(t)).toHaveLength(3);
  });

  it("stays quiet about a code that is one recipient's problem, like a mistyped number", async () => {
    const t = setup();
    await sendWithTwilioError(t, 400, 21211);
    expect(await adminAlerts(t)).toHaveLength(0);
  });

  it("alerts when Twilio cannot be reached at all", async () => {
    const t = setup();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("timed out", "TimeoutError"); }));
    vi.stubEnv("SMS_ENABLED", "true");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG123");
    await expect(
      t.action(internal.sms.sendMatchAlert, { userId: "u", phone: PHONE, monitorName: "Huts", monitorId: "m1", matchCount: 1 }),
    ).rejects.toThrow();

    const alerts = await adminAlerts(t);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("could not reach Twilio");
  });

  it("asks Twilio to report the final delivery status to our callback", async () => {
    const t = setup();
    await sendWithTwilioError(t, 500, 20500);
    const body = vi.mocked(fetch).mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get("StatusCallback")).toBe(`${SITE}/twilio/status`);
  });
});

describe("Twilio status callback", () => {
  async function post(t: AnyTest, params: Record<string, string>, signature?: string) {
    const body = new URLSearchParams(params);
    const sig = signature ?? (await twilioSignature(AUTH_TOKEN, `${SITE}/twilio/status`, body));
    return t.fetch("/twilio/status", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": sig },
      body: body.toString(),
    });
  }

  const FAILED = { MessageSid: "SM123", MessageStatus: "undelivered", ErrorCode: "21704", To: PHONE };

  it("rejects a bad signature with 403 and alerts nobody", async () => {
    const t = setup();
    const res = await post(t, FAILED, "AAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    expect(res.status).toBe(403);
    expect(await adminAlerts(t)).toHaveLength(0);
  });

  it("rejects a request signed for different params", async () => {
    const t = setup();
    const sig = await twilioSignature(AUTH_TOKEN, `${SITE}/twilio/status`, new URLSearchParams(FAILED));
    const res = await post(t, { ...FAILED, ErrorCode: "30003" }, sig);
    expect(res.status).toBe(403);
  });

  it("rejects a request with no signature header", async () => {
    const t = setup();
    const res = await t.fetch("/twilio/status", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(FAILED).toString(),
    });
    expect(res.status).toBe(403);
  });

  it.each(["failed", "undelivered"])("alerts the admin on %s with code, masked number and sid", async (status) => {
    const t = setup();
    const res = await post(t, { ...FAILED, MessageStatus: status });
    expect(res.status).toBe(200);

    const alerts = await adminAlerts(t);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("21704");
    expect(alerts[0]).toContain("SM123");
    expect(alerts[0]).toContain("3456");
    expect(alerts[0]).not.toContain("7911123456");
  });

  it.each(["queued", "sent", "delivered"])("ignores %s", async (status) => {
    const t = setup();
    const res = await post(t, { ...FAILED, MessageStatus: status });
    expect(res.status).toBe(200);
    expect(await adminAlerts(t)).toHaveLength(0);
  });

  it("rate-limits repeated callbacks for the same error code", async () => {
    const t = setup();
    await post(t, FAILED);
    await post(t, { ...FAILED, MessageSid: "SM456" });
    expect(await adminAlerts(t)).toHaveLength(1);
  });

  it.each(["30003", "30005", "30006"])("stays quiet about %s, a phone that is off or not a mobile", async (code) => {
    const t = setup();
    await post(t, { ...FAILED, ErrorCode: code });
    expect(await adminAlerts(t)).toHaveLength(0);
  });
});

describe("reserveSmsSend: the cap notice's upgrade link", () => {
  async function exhausted(tier: "free" | "max", used: number) {
    const t = convexTest(schema, modules);
    const month = new Date().toISOString().slice(0, 7);
    await t.run((ctx) =>
      ctx.db.insert("userTiers", {
        userId: "u1",
        tier,
        smsMonth: month,
        smsMonthCount: used,
        updatedAt: Date.now(),
      }),
    );
    return t.mutation(internal.tiers.reserveSmsSend, { userId: "u1" });
  }

  it("offers an upgrade to a free account that has run out", async () => {
    const r = await exhausted("free", 10);
    expect(r).toMatchObject({ ok: false, reason: "month", notice: { limit: 10, canUpgrade: true } });
  });

  it("offers nothing to the top plan, which has nowhere to go", async () => {
    const r = await exhausted("max", 200);
    expect(r).toMatchObject({ ok: false, reason: "month", notice: { limit: 200, canUpgrade: false } });
  });

  // The notice names a month. Taking the clock again in the action, after the
  // reservation, could name the next one when the send straddles midnight UTC.
  it("stamps the notice with the moment the allowance was found spent", async () => {
    const r = await exhausted("free", 10);
    expect(r.notice?.at).toBe(Date.now());
  });
});

describe("admin visibility", () => {
  async function counter(t: AnyTest, name: string): Promise<number> {
    return t.run(async (ctx) => {
      const row = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique();
      return row?.value ?? 0;
    });
  }
  const today = () => new Date().toISOString().slice(0, 10);

  function twilioAnswers(status: number, body: object) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
    vi.stubEnv("SMS_ENABLED", "true");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG123");
  }

  it("counts a text Twilio accepted against today", async () => {
    const t = setup();
    twilioAnswers(201, { sid: "SM1" });
    await t.action(internal.sms.sendMatchAlert, { userId: "u", phone: PHONE, monitorName: "Huts", monitorId: "m1", matchCount: 1 });
    expect(await counter(t, `sms:sent:${today()}`)).toBe(1);
    expect(await counter(t, `sms:failed:${today()}`)).toBe(0);
  });

  // Counted even when the code is one recipient's problem and raises no alert:
  // the digest is the place a steady trickle of those should show up.
  it("counts every failure against today, including ones too minor to alert on", async () => {
    const t = setup();
    twilioAnswers(400, { code: 21211 });
    await expect(
      t.action(internal.sms.sendMatchAlert, { userId: "u", phone: PHONE, monitorName: "Huts", monitorId: "m1", matchCount: 1 }),
    ).rejects.toThrow();
    expect(await counter(t, `sms:failed:${today()}`)).toBe(1);
    expect(await counter(t, `sms:sent:${today()}`)).toBe(0);
  });

  it("tells the admin when someone confirms a phone, with their email and a masked number", async () => {
    const t = setup();
    const user = (await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: { name: "A Person", email: "person@example.test", emailVerified: true, createdAt: Date.now(), updatedAt: Date.now() },
      },
    })) as { _id: string };
    const code = await t.mutation(internal.sms.claimVerification, { userId: user._id, phone: PHONE });
    await t.withIdentity({ subject: user._id }).mutation(api.sms.confirmVerification, { code });

    const alerts = await adminAlerts(t);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("SMS turned on");
    expect(alerts[0]).toContain("person@example.test");
    expect(alerts[0]).toContain("3456");
    expect(alerts[0]).not.toContain("7911123456");
  });

  it("says nothing on a wrong code", async () => {
    const t = setup();
    const user = (await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: { name: "A Person", email: "person@example.test", emailVerified: true, createdAt: Date.now(), updatedAt: Date.now() },
      },
    })) as { _id: string };
    const code = await t.mutation(internal.sms.claimVerification, { userId: user._id, phone: PHONE });
    const wrong = code === "000000" ? "111111" : "000000";
    await expect(t.withIdentity({ subject: user._id }).mutation(api.sms.confirmVerification, { code: wrong })).rejects.toThrow();
    expect(await adminAlerts(t)).toHaveLength(0);
  });
});

describe("a number Twilio will never deliver to", () => {
  async function smsRow(t: AnyTest) {
    return t.run((ctx) =>
      ctx.db.query("notificationSettings").withIndex("by_userId_channel", (q) => q.eq("userId", "u").eq("channel", "sms")).unique(),
    );
  }
  async function alert(t: AnyTest) {
    return t.action(internal.sms.sendMatchAlert, { userId: "u", phone: PHONE, monitorName: "Huts", monitorId: "m1", matchCount: 1 }).catch(() => {});
  }
  function twilio(status: number, code: number) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code }), { status })));
    vi.stubEnv("SMS_ENABLED", "true");
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MG123");
  }
  async function seed(t: AnyTest) {
    await t.run((ctx) => ctx.db.insert("notificationSettings", { userId: "u", channel: "sms", enabled: true, target: PHONE }));
  }

  // The user's slots are refunded on a failed send but the global budget is
  // not, so without this a STOP'd number spends the budget on every alert.
  it.each([21610, 21211, 21614])("turns the user's texts off after a %s", async (code) => {
    const t = setup();
    await seed(t);
    twilio(400, code);
    await alert(t);
    expect((await smsRow(t))?.enabled).toBe(false);
  });

  it("leaves texts on after an error that is not about the number", async () => {
    const t = setup();
    await seed(t);
    twilio(500, 20500);
    await alert(t);
    expect((await smsRow(t))?.enabled).toBe(true);
  });
});
