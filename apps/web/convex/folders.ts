import { ConvexError, v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/** Folders one user may hold. Enough for any real set of builds and trips. */
const MAX_FOLDERS = 50;
const MAX_FOLDER_NAME = 100;

async function userIdOf(ctx: QueryCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Not authenticated");
  return identity.subject;
}

/** Takes a raw id so an agent's string is checked the same way as the app's. */
export async function ownedFolder(ctx: QueryCtx, userId: string, folderId: string) {
  const id = ctx.db.normalizeId("folders", folderId);
  const folder = id ? await ctx.db.get(id) : null;
  if (!folder || folder.userId !== userId) throw new ConvexError("Folder not found");
  return folder;
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new ConvexError("Give the folder a name.");
  if (trimmed.length > MAX_FOLDER_NAME) throw new ConvexError(`Folder names are at most ${MAX_FOLDER_NAME} characters.`);
  return trimmed;
}

/**
 * The user's folder with this name, made if there is none. Names compare
 * without case, so an agent asking for "PC build" in a later session finds
 * the folder it made before instead of a twin.
 */
export async function createFolderForUser(ctx: MutationCtx, userId: string, name: string): Promise<Id<"folders">> {
  const clean = cleanName(name);
  const folders = await ctx.db.query("folders").withIndex("by_userId", (q) => q.eq("userId", userId)).collect();
  const same = folders.find((f) => f.name.toLowerCase() === clean.toLowerCase());
  if (same) return same._id;
  if (folders.length >= MAX_FOLDERS) throw new ConvexError(`Folder limit reached: you can have at most ${MAX_FOLDERS} folders.`);
  const now = Date.now();
  return ctx.db.insert("folders", { userId, name: clean, createdAt: now, updatedAt: now });
}

/** File a monitor in a folder, or take it out with null. */
export async function setMonitorFolder(ctx: MutationCtx, userId: string, monitorId: Id<"monitors">, folderId: string | null) {
  const monitor = await ctx.db.get(monitorId);
  if (!monitor || monitor.userId !== userId) throw new ConvexError("Monitor not found");
  // The dashboard shows a product's monitors under the product, so filing
  // one on its own would look like nothing happened.
  if (monitor.groupId) throw new ConvexError("This monitor is part of a product. Move the product instead.");
  const folder = folderId === null ? null : await ownedFolder(ctx, userId, folderId);
  await ctx.db.patch(monitorId, { folderId: folder?._id, updatedAt: Date.now() });
}

/** File a product in a folder, or take it out with null. */
export async function setProductFolder(ctx: MutationCtx, userId: string, productId: Id<"monitorGroups">, folderId: string | null) {
  const product = await ctx.db.get(productId);
  if (!product || product.userId !== userId) throw new ConvexError("Product not found");
  const folder = folderId === null ? null : await ownedFolder(ctx, userId, folderId);
  await ctx.db.patch(productId, { folderId: folder?._id, updatedAt: Date.now() });
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];
    const folders = await ctx.db.query("folders").withIndex("by_userId", (q) => q.eq("userId", identity.subject)).collect();
    return folders.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => createFolderForUser(ctx, await userIdOf(ctx), name),
});

export const rename = mutation({
  args: { id: v.id("folders"), name: v.string() },
  handler: async (ctx, { id, name }) => {
    const folder = await ownedFolder(ctx, await userIdOf(ctx), id);
    await ctx.db.patch(folder._id, { name: cleanName(name), updatedAt: Date.now() });
  },
});

/** Delete a folder. What was in it stays, outside any folder. */
export const remove = mutation({
  args: { id: v.id("folders") },
  handler: async (ctx, { id }) => {
    const folder = await ownedFolder(ctx, await userIdOf(ctx), id);
    for (const monitor of await ctx.db.query("monitors").withIndex("by_folderId", (q) => q.eq("folderId", folder._id)).collect()) {
      await ctx.db.patch(monitor._id, { folderId: undefined });
    }
    for (const product of await ctx.db.query("monitorGroups").withIndex("by_folderId", (q) => q.eq("folderId", folder._id)).collect()) {
      await ctx.db.patch(product._id, { folderId: undefined });
    }
    await ctx.db.delete(folder._id);
  },
});

export const move = mutation({
  args: {
    monitorId: v.optional(v.id("monitors")),
    productId: v.optional(v.id("monitorGroups")),
    folderId: v.union(v.id("folders"), v.null()),
  },
  handler: async (ctx, { monitorId, productId, folderId }) => {
    const userId = await userIdOf(ctx);
    if (monitorId) await setMonitorFolder(ctx, userId, monitorId, folderId);
    if (productId) await setProductFolder(ctx, userId, productId, folderId);
  },
});
