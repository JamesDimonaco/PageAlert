import { createClient } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import type { GenericCtx } from "@convex-dev/better-auth/utils";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { polar, checkout, portal, webhooks } from "@polar-sh/better-auth";
import { Polar } from "@polar-sh/sdk";
import { components } from "../_generated/api";
import type { DataModel } from "../_generated/dataModel";
import authConfig from "../auth.config";
import schema from "./schema";

export const authComponent = createClient<DataModel, typeof schema>(
  components.betterAuth,
  {
    local: { schema },
    verbose: false,
  },
);

// Polar billing client
const polarEnv = process.env.POLAR_ENVIRONMENT;
const polarServer: "sandbox" | "production" = (() => {
  if (!polarEnv || polarEnv === "sandbox") return "sandbox";
  if (polarEnv === "production") return "production";
  throw new Error(`Invalid POLAR_ENVIRONMENT: "${polarEnv}". Must be "sandbox" or "production".`);
})();

const polarClient = process.env.POLAR_ACCESS_TOKEN
  ? new Polar({
      accessToken: process.env.POLAR_ACCESS_TOKEN,
      server: polarServer,
    })
  : null;

const PRO_PRODUCT_ID = process.env.POLAR_PRO_PRODUCT_ID;
const MAX_PRODUCT_ID = process.env.POLAR_MAX_PRODUCT_ID;

function productIdToTier(productId: string): "pro" | "max" | null {
  if (productId === MAX_PRODUCT_ID) return "max";
  if (productId === PRO_PRODUCT_ID) return "pro";
  return null;
}

export const createAuthOptions = (ctx: GenericCtx<DataModel>) => {
  const plugins: BetterAuthOptions["plugins"] = [convex({ authConfig })];

  if (polarClient) {
    plugins.push(
      polar({
        client: polarClient,
        createCustomerOnSignUp: true,
        use: [
          checkout({
            products: [
              ...(PRO_PRODUCT_ID ? [{ productId: PRO_PRODUCT_ID, slug: "pro" }] : []),
              ...(MAX_PRODUCT_ID ? [{ productId: MAX_PRODUCT_ID, slug: "max" }] : []),
            ],
            successUrl: `${process.env.SITE_URL ?? "https://pagealert.io"}/dashboard/settings?upgraded=true`,
            authenticatedUsersOnly: true,
          }),
          portal(),
          ...(process.env.POLAR_WEBHOOK_SECRET ? [webhooks({
            secret: process.env.POLAR_WEBHOOK_SECRET,

            onSubscriptionCreated: async (payload) => {
              const sub = payload.data;
              const tier = productIdToTier(sub.productId);
              console.log("[polar] Subscription created:", sub.id, "product:", sub.productId, "tier:", tier, "customer:", sub.customerId);
              // Tier sync happens client-side via useTier() refetch on window focus
              // and via the ?upgraded=true redirect param
            },

            onSubscriptionCanceled: async (payload) => {
              const sub = payload.data;
              console.log("[polar] Subscription canceled:", sub.id);
              // User will be downgraded when subscription.revoked fires
              // or when the billing period ends
            },

            onOrderPaid: async (payload) => {
              console.log("[polar] Order paid:", payload.data.id);
            },
          })] : []),
        ],
      })
    );
  }

  return {
    appName: "PageAlert",
    baseURL: process.env.SITE_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    database: authComponent.adapter(ctx),
    emailAndPassword: {
      enabled: true,
    },
    socialProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      },
      github: {
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      },
    },
    plugins,
  } satisfies BetterAuthOptions;
};

export const options = createAuthOptions({} as GenericCtx<DataModel>);

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth(createAuthOptions(ctx));
};
