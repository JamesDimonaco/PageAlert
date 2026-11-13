/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import betterAuthSchema from "./betterAuth/schema";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

function setup() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

async function seed(t: ReturnType<typeof setup>, userId: string) {
  const as = t.withIdentity({ subject: userId });
  const monitor = await t.run((ctx) =>
    ctx.db.insert("monitors", {
      userId, name: "RAM", url: "https://shop.test/ram", prompt: "x", status: "active", checkInterval: "1h",
      matchCount: 0, createdAt: 0, updatedAt: 0,
    })
  );
  const product = await t.run((ctx) =>
    ctx.db.insert("monitorGroups", {
      userId, name: "Cooler", region: "GB", alertOn: { backInStock: true }, checkInterval: "1h", listings: [],
      createdAt: 0, updatedAt: 0,
    })
  );
  return { as, monitor, product };
}

// Tidying up must never lose a monitor: deleting a folder empties it, nothing more.
test("a folder holds monitors and products, and deleting it keeps them", async () => {
  const t = setup();
  const { as, monitor, product } = await seed(t, "user_1");
  const folderId = await as.mutation(api.folders.create, { name: "PC build" });
  await as.mutation(api.folders.move, { monitorId: monitor, folderId });
  await as.mutation(api.folders.move, { productId: product, folderId });
  expect((await t.run((ctx) => ctx.db.get(monitor)))?.folderId).toBe(folderId);
  expect((await t.run((ctx) => ctx.db.get(product)))?.folderId).toBe(folderId);
  expect(await as.query(api.folders.list, {})).toMatchObject([{ _id: folderId, name: "PC build" }]);

  await as.mutation(api.folders.rename, { id: folderId, name: "Gaming PC" });
  expect((await as.query(api.folders.list, {}))[0]?.name).toBe("Gaming PC");

  await as.mutation(api.folders.remove, { id: folderId });
  expect(await as.query(api.folders.list, {})).toEqual([]);
  expect((await t.run((ctx) => ctx.db.get(monitor)))?.folderId).toBeUndefined();
  expect((await t.run((ctx) => ctx.db.get(product)))?.folderId).toBeUndefined();
});

test("moving to no folder takes a monitor out", async () => {
  const t = setup();
  const { as, monitor } = await seed(t, "user_1");
  const folderId = await as.mutation(api.folders.create, { name: "PC build" });
  await as.mutation(api.folders.move, { monitorId: monitor, folderId });
  await as.mutation(api.folders.move, { monitorId: monitor, folderId: null });
  expect((await t.run((ctx) => ctx.db.get(monitor)))?.folderId).toBeUndefined();
});

// An agent asking for "PC build" twice, in two sessions, means the same folder.
test("creating a folder whose name exists returns the existing one", async () => {
  const t = setup();
  const { as } = await seed(t, "user_1");
  const first = await as.mutation(api.folders.create, { name: "PC build" });
  expect(await as.mutation(api.folders.create, { name: " pc BUILD " })).toBe(first);
});

test("nobody can file into, rename or delete another user's folder", async () => {
  const t = setup();
  const owner = await seed(t, "user_1");
  const other = await seed(t, "user_2");
  const folderId = await owner.as.mutation(api.folders.create, { name: "PC build" });
  await expect(other.as.mutation(api.folders.move, { monitorId: other.monitor, folderId })).rejects.toThrow(/Folder not found/);
  await expect(other.as.mutation(api.folders.rename, { id: folderId, name: "mine" })).rejects.toThrow(/Folder not found/);
  await expect(other.as.mutation(api.folders.remove, { id: folderId })).rejects.toThrow(/Folder not found/);
  await expect(other.as.mutation(api.folders.move, { monitorId: owner.monitor, folderId: null })).rejects.toThrow(/not found/);
});

test("a user can hold at most 50 folders", async () => {
  const t = setup();
  const { as } = await seed(t, "user_1");
  for (let i = 0; i < 50; i++) await as.mutation(api.folders.create, { name: `f${i}` });
  await expect(as.mutation(api.folders.create, { name: "one more" })).rejects.toThrow(/50 folders/);
});

// create_folder returns the folder with that name, so names must stay unique.
test("renaming a folder to a name already in use is refused", async () => {
  const t = setup();
  const as = t.withIdentity({ subject: "user_1" });
  await as.mutation(api.folders.create, { name: "PC build" });
  const trip = await as.mutation(api.folders.create, { name: "Trip" });
  await expect(as.mutation(api.folders.rename, { id: trip, name: "pc build" })).rejects.toThrow(/already have a folder/);
  // Its own name in another case is fine.
  await as.mutation(api.folders.rename, { id: trip, name: "TRIP" });
});
