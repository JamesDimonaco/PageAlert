import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { components } from "./_generated/api";
import { hashOAuthToken } from "./betterAuth/auth";

/**
 * AI apps that connected over OAuth (Claude, ChatGPT). Better Auth's
 * oauthProvider plugin runs the sign-in and writes the rows; this file reads
 * them to check a call's token and to let a user see and cut a connection.
 */

/** Every connection has to fit in the Connect AI card, the only place to remove one. */
const MAX_LISTED = 50;

/**
 * The account an OAuth access token acts for, or null for a token that is
 * unknown, expired, or whose account is gone. Read from the table on every
 * call, so a disconnect takes effect on the next one.
 */
export async function findTokenOwner(
  ctx: QueryCtx,
  token: string
): Promise<{ userId: string; userEmail: string | undefined } | null> {
  const row = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "oauthAccessToken",
    where: [{ field: "token", operator: "eq", value: await hashOAuthToken(token) }],
  })) as { userId?: string | null; expiresAt?: number | null } | null;
  if (!row?.userId || !row.expiresAt || row.expiresAt <= Date.now()) return null;
  const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "user",
    where: [{ field: "_id", operator: "eq", value: row.userId }],
  })) as { email?: string } | null;
  if (!user) return null;
  return { userId: row.userId, userEmail: user.email };
}

type Where = { field: "userId" | "clientId"; operator: "eq"; value: string };

/**
 * Deletes a user's access tokens, refresh tokens and approvals, for one app
 * or for all of them. The refresh tokens matter most: one left behind would
 * mint a new access token.
 */
export async function deleteOAuthRows(ctx: MutationCtx, userId: string, clientId?: string): Promise<void> {
  const where: Where[] = [{ field: "userId", operator: "eq", value: userId }];
  if (clientId !== undefined) where.push({ field: "clientId", operator: "eq", value: clientId });
  for (const model of ["oauthAccessToken", "oauthRefreshToken", "oauthConsent"] as const) {
    for (let page = 0; page < 40; page++) {
      const result = await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
        input: { model, where },
        paginationOpts: { numItems: 200, cursor: null },
      });
      if (result.count === 0 || result.isDone) break;
    }
  }
}

export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const { page } = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model: "oauthConsent",
      where: [{ field: "userId", operator: "eq", value: identity.subject }],
      paginationOpts: { numItems: MAX_LISTED, cursor: null },
    })) as { page: { clientId: string; createdAt?: number | null }[] };
    return Promise.all(
      page.map(async ({ clientId, createdAt }) => {
        const client = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
          model: "oauthClient",
          where: [{ field: "clientId", operator: "eq", value: clientId }],
        })) as { name?: string | null } | null;
        return { clientId, name: client?.name || "An AI app", connectedAt: createdAt ?? null };
      })
    );
  },
});

export const disconnect = mutation({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");
    await deleteOAuthRows(ctx, identity.subject, clientId);
  },
});
