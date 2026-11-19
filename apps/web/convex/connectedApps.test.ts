/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, components } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";
import { hashOAuthToken, withRevocableRefreshTokens } from "./betterAuth/auth";
import { deleteAuthIdentity } from "./account";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}
type T = ReturnType<typeof setup>;

async function seedUser(t: T, email: string) {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: { name: "A Person", email, emailVerified: true, createdAt: NOW, updatedAt: NOW },
    },
  })) as { _id: string };
  return { userId: user._id, asUser: t.withIdentity({ subject: user._id, email }) };
}

async function seedClient(t: T, clientId: string, name: string) {
  await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "oauthClient",
      data: { clientId, name, redirectUris: ["https://claude.ai/api/mcp/auth_callback"], createdAt: NOW },
    },
  });
}

/** The rows Better Auth writes when a user approves an app, with a live access token. */
async function connect(
  t: T,
  userId: string,
  clientId: string,
  token: string,
  expiresAt = NOW + HOUR
) {
  await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "oauthConsent",
      data: { clientId, userId, scopes: ["offline_access"], createdAt: NOW, updatedAt: NOW },
    },
  });
  const refresh = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "oauthRefreshToken",
      data: {
        token: await hashOAuthToken(`refresh-${token}`),
        clientId,
        userId,
        scopes: ["offline_access"],
        createdAt: NOW,
        expiresAt: NOW + 30 * 24 * HOUR,
      },
    },
  })) as { _id: string };
  await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "oauthAccessToken",
      data: {
        token: await hashOAuthToken(token),
        clientId,
        userId,
        refreshId: refresh._id,
        scopes: ["offline_access"],
        createdAt: NOW,
        expiresAt,
      },
    },
  });
}

async function rowsLeft(t: T, model: "oauthAccessToken" | "oauthRefreshToken" | "oauthConsent", userId: string) {
  const { page } = await t.query(components.betterAuth.adapter.findMany, {
    model,
    where: [{ field: "userId", operator: "eq", value: userId }],
    paginationOpts: { numItems: 50, cursor: null },
  });
  return page.length;
}

const MONITOR = { url: "https://example.com/huts", prompt: "any Feb start date", name: "Milford" };
const REFUSED = "Invalid API key";

test("an app's token acts for the user who approved it, and nobody else", async () => {
  const t = setup();
  const ann = await seedUser(t, "ann@example.com");
  const bob = await seedUser(t, "bob@example.com");
  await seedClient(t, "claude", "Claude");
  await connect(t, ann.userId, "claude", "ann-token");
  await connect(t, bob.userId, "claude", "bob-token");

  const annMonitor = await t.mutation(api.mcp.createMonitor, { apiKey: "ann-token", ...MONITOR });
  const stored = await t.run((ctx) => ctx.db.get(annMonitor));
  // Alerts go to userEmail, so a token that resolved the wrong user would email a stranger.
  expect(stored).toMatchObject({ userId: ann.userId, userEmail: "ann@example.com" });

  expect(await t.query(api.mcp.listMonitors, { apiKey: "ann-token" })).toHaveLength(1);
  expect(await t.query(api.mcp.listMonitors, { apiKey: "bob-token" })).toEqual([]);
  await expect(t.query(api.mcp.getMatches, { apiKey: "bob-token", monitorId: annMonitor })).rejects.toThrow();
  await expect(t.mutation(api.mcp.deleteMonitor, { apiKey: "bob-token", monitorId: annMonitor })).rejects.toThrow();
  expect(await t.run((ctx) => ctx.db.get(annMonitor))).not.toBeNull();
});

test("the route's gate accepts a live token and names its user", async () => {
  const t = setup();
  const ann = await seedUser(t, "ann@example.com");
  await seedClient(t, "claude", "Claude");
  await connect(t, ann.userId, "claude", "ann-token");
  expect(await t.mutation(api.apiKeys.verify, { key: "ann-token" })).toEqual({ userId: ann.userId });
  expect(await t.mutation(api.apiKeys.verify, { key: "not-a-token" })).toBeNull();
});

test("a token stops working the moment it expires", async () => {
  const t = setup();
  const ann = await seedUser(t, "ann@example.com");
  await seedClient(t, "claude", "Claude");
  await connect(t, ann.userId, "claude", "ann-token", NOW + HOUR);

  vi.setSystemTime(NOW + HOUR - 1);
  expect(await t.query(api.mcp.listMonitors, { apiKey: "ann-token" })).toEqual([]);

  vi.setSystemTime(NOW + HOUR);
  await expect(t.query(api.mcp.listMonitors, { apiKey: "ann-token" })).rejects.toThrow(REFUSED);
  await expect(t.mutation(api.mcp.createMonitor, { apiKey: "ann-token", ...MONITOR })).rejects.toThrow(REFUSED);
  expect(await t.mutation(api.apiKeys.verify, { key: "ann-token" })).toBeNull();
});

test("a token with no expiry is refused", async () => {
  const t = setup();
  const ann = await seedUser(t, "ann@example.com");
  await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "oauthAccessToken",
      data: { token: await hashOAuthToken("forever"), clientId: "claude", userId: ann.userId, scopes: [] },
    },
  });
  await expect(t.query(api.mcp.listMonitors, { apiKey: "forever" })).rejects.toThrow(REFUSED);
});

test("the stored hash is not itself a credential", async () => {
  const t = setup();
  const ann = await seedUser(t, "ann@example.com");
  await seedClient(t, "claude", "Claude");
  await connect(t, ann.userId, "claude", "ann-token");
  const hash = await hashOAuthToken("ann-token");
  await expect(t.query(api.mcp.listMonitors, { apiKey: hash })).rejects.toThrow(REFUSED);
});

test("disconnecting an app revokes its tokens at once and forgets the approval", async () => {
  const t = setup();
  const ann = await seedUser(t, "ann@example.com");
  await seedClient(t, "claude", "Claude");
  await seedClient(t, "chatgpt", "ChatGPT");
  await connect(t, ann.userId, "claude", "claude-token");
  await connect(t, ann.userId, "chatgpt", "chatgpt-token");

  await ann.asUser.mutation(api.connectedApps.disconnect, { clientId: "claude" });

  await expect(t.query(api.mcp.listMonitors, { apiKey: "claude-token" })).rejects.toThrow(REFUSED);
  expect(await t.mutation(api.apiKeys.verify, { key: "claude-token" })).toBeNull();
  // The other app is untouched.
  expect(await t.query(api.mcp.listMonitors, { apiKey: "chatgpt-token" })).toEqual([]);
  // One row of each kind left: ChatGPT's. A surviving refresh token would mint a new access token.
  expect(await rowsLeft(t, "oauthAccessToken", ann.userId)).toBe(1);
  expect(await rowsLeft(t, "oauthRefreshToken", ann.userId)).toBe(1);
  expect(await rowsLeft(t, "oauthConsent", ann.userId)).toBe(1);
  expect((await ann.asUser.query(api.connectedApps.listMine, {})).map((a) => a.name)).toEqual(["ChatGPT"]);
});

test("disconnecting only touches the caller's own connection", async () => {
  const t = setup();
  const ann = await seedUser(t, "ann@example.com");
  const bob = await seedUser(t, "bob@example.com");
  await seedClient(t, "claude", "Claude");
  await connect(t, ann.userId, "claude", "ann-token");
  await connect(t, bob.userId, "claude", "bob-token");

  await bob.asUser.mutation(api.connectedApps.disconnect, { clientId: "claude" });

  expect(await t.query(api.mcp.listMonitors, { apiKey: "ann-token" })).toEqual([]);
  expect(await rowsLeft(t, "oauthRefreshToken", ann.userId)).toBe(1);
  await expect(t.mutation(api.connectedApps.disconnect, { clientId: "claude" })).rejects.toThrow("Not authenticated");
});

test("lists the caller's connected apps by name, and nobody else's", async () => {
  const t = setup();
  const ann = await seedUser(t, "ann@example.com");
  const bob = await seedUser(t, "bob@example.com");
  await seedClient(t, "claude", "Claude");
  await seedClient(t, "chatgpt", "ChatGPT");
  await connect(t, ann.userId, "claude", "ann-token");
  await connect(t, bob.userId, "chatgpt", "bob-token");

  expect(await ann.asUser.query(api.connectedApps.listMine, {})).toEqual([
    { clientId: "claude", name: "Claude", connectedAt: NOW },
  ]);
  expect(await t.query(api.connectedApps.listMine, {})).toEqual([]);
});

test("a banned user's token is refused", async () => {
  const t = setup();
  const ann = await seedUser(t, "ann@example.com");
  await seedClient(t, "claude", "Claude");
  await connect(t, ann.userId, "claude", "ann-token");
  await t.run((ctx) => ctx.db.insert("bannedUsers", { userId: ann.userId, email: "ann@example.com", bannedAt: NOW, bannedBy: "admin" }));
  await expect(t.query(api.mcp.listMonitors, { apiKey: "ann-token" })).rejects.toThrow(REFUSED);
});

test("deleting an account removes its tokens and approvals", async () => {
  const t = setup();
  const ann = await seedUser(t, "ann@example.com");
  await seedClient(t, "claude", "Claude");
  await connect(t, ann.userId, "claude", "ann-token");

  await t.run((ctx) => deleteAuthIdentity(ctx, ann.userId));

  await expect(t.query(api.mcp.listMonitors, { apiKey: "ann-token" })).rejects.toThrow(REFUSED);
  expect(await rowsLeft(t, "oauthAccessToken", ann.userId)).toBe(0);
  expect(await rowsLeft(t, "oauthRefreshToken", ann.userId)).toBe(0);
  expect(await rowsLeft(t, "oauthConsent", ann.userId)).toBe(0);
});

test("a new refresh token is stored as not revoked, which is what lets it be rotated", async () => {
  const stored: unknown[] = [];
  const factory = (() => ({
    create: async (input: { data: unknown }) => {
      stored.push(input);
      return input.data;
    },
  })) as unknown as Parameters<typeof withRevocableRefreshTokens>[0];
  const adapter = withRevocableRefreshTokens(factory)({});

  await adapter.create({ model: "oauthRefreshToken", data: { token: "r" } });
  await adapter.create({ model: "oauthAccessToken", data: { token: "a" } });

  expect(stored).toEqual([
    { model: "oauthRefreshToken", data: { token: "r", revoked: null } },
    { model: "oauthAccessToken", data: { token: "a" } },
  ]);
});
