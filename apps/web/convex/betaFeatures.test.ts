/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api, components } from "./_generated/api";
import schema from "./schema";
import betterAuthSchema from "./betterAuth/schema";
import { hasBetaFeature } from "./betaFeatures";

const modules = import.meta.glob("./**/*.*s");
const betterAuthModules = import.meta.glob("./betterAuth/**/*.*s");

function harness() {
  const t = convexTest(schema, modules);
  t.registerComponent("betterAuth", betterAuthSchema, betterAuthModules);
  return t;
}

async function signUp(t: ReturnType<typeof harness>, email: string): Promise<string> {
  const user = (await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: { name: "A Person", email, emailVerified: true, createdAt: 0, updatedAt: 0 },
    },
  })) as { _id: string };
  return user._id;
}

const findAProduct = (t: ReturnType<typeof harness>, userId: string) =>
  t.run((ctx) => hasBetaFeature(ctx, userId, "find_a_product"));

// Ticket 06 refuses searches on this answer, so a wrong "true" opens the beta to everyone.
describe("betaFeatures: Find a product", () => {
  it("is off for a user who never touched it", async () => {
    const t = harness();
    const userId = await signUp(t, "a@example.test");
    await t.run((ctx) => ctx.db.insert("userActivity", { userId, lastSeenAt: 0 }));
    expect(await findAProduct(t, userId)).toBe(false);
  });

  it("turns on and off for the signed-in user only", async () => {
    const t = harness();
    const alice = await signUp(t, "a@example.test");
    const bob = await signUp(t, "b@example.test");

    await t.withIdentity({ subject: alice }).mutation(api.betaFeatures.set, { feature: "find_a_product", enabled: true });
    expect(await findAProduct(t, alice)).toBe(true);
    expect(await findAProduct(t, bob)).toBe(false);

    await t.withIdentity({ subject: alice }).mutation(api.betaFeatures.set, { feature: "find_a_product", enabled: false });
    expect(await findAProduct(t, alice)).toBe(false);
  });
});
