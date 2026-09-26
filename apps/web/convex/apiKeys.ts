import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { apiKeyHint, formatApiKey, hashApiKey, looksLikeApiKey } from "@prowl/shared";
import { isBanned, requireLiveAccount } from "./account";

const MAX_NAME_LENGTH = 100;
const MAX_LISTED_KEYS = 50;
/** lastUsedAt is for "is this key still in use?", so hourly is plenty and saves a write per call. */
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

export type KeyOwner = { keyId: string; userId: string; userEmail: string | undefined };

async function findKey(ctx: QueryCtx, key: string) {
  if (!looksLikeApiKey(key)) return null;
  const keyHash = await hashApiKey(key);
  const row = await ctx.db
    .query("apiKeys")
    .withIndex("by_keyHash", (q) => q.eq("keyHash", keyHash))
    .unique();
  if (!row || (await isBanned(ctx, row.userId))) return null;
  return row;
}

/**
 * The account an MCP call acts for. The key is the whole credential, the same
 * way a session is for the web app, so every MCP function starts here.
 */
export async function requireKeyOwner(ctx: QueryCtx, key: string): Promise<KeyOwner> {
  const row = await findKey(ctx, key);
  if (!row) throw new ConvexError("Invalid API key");
  return { keyId: row._id, userId: row.userId, userEmail: row.userEmail };
}

async function requireUser(ctx: QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Not authenticated");
  return identity;
}

/** Returns the key in plaintext. This is the only time it exists outside the caller. */
export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx: MutationCtx, { name }) => {
    const identity = await requireUser(ctx);
    const trimmed = name.trim();
    if (trimmed.length === 0) throw new Error("Name is required");
    if (trimmed.length > MAX_NAME_LENGTH) throw new Error(`Name exceeds ${MAX_NAME_LENGTH} characters`);
    if (await isBanned(ctx, identity.subject)) throw new Error("This account has been suspended.");
    await requireLiveAccount(ctx, identity.subject);

    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const key = formatApiKey(bytes);
    await ctx.db.insert("apiKeys", {
      userId: identity.subject,
      userEmail: identity.email ?? undefined,
      name: trimmed,
      keyHash: await hashApiKey(key),
      hint: apiKeyHint(key),
      createdAt: Date.now(),
    });
    return { key };
  },
});

export const revoke = mutation({
  args: { id: v.id("apiKeys") },
  handler: async (ctx, { id }) => {
    const identity = await requireUser(ctx);
    const row = await ctx.db.get(id);
    if (!row || row.userId !== identity.subject) throw new Error("Key not found");
    await ctx.db.delete(id);
  },
});

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const rows = await ctx.db
      .query("apiKeys")
      .withIndex("by_userId", (q) => q.eq("userId", identity.subject))
      .order("desc")
      .take(MAX_LISTED_KEYS);
    return rows.map(({ _id, name, hint, createdAt, lastUsedAt }) => ({ _id, name, hint, createdAt, lastUsedAt }));
  },
});

/**
 * Checks a key for the MCP route before it runs any tool, and records that the
 * key was used. Null for anything that is not a live key.
 */
export const verify = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const row = await findKey(ctx, key);
    if (!row) return null;
    const now = Date.now();
    if (row.lastUsedAt === undefined || now - row.lastUsedAt >= LAST_USED_RESOLUTION_MS) {
      await ctx.db.patch(row._id, { lastUsedAt: now });
    }
    return { userId: row.userId };
  },
});
