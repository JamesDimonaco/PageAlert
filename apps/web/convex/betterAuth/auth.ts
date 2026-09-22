import { createClient } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import type { GenericCtx } from "@convex-dev/better-auth/utils";
import type { ActionCtx } from "../_generated/server";
import type { BetterAuthOptions } from "better-auth";
import { betterAuth } from "better-auth";
import { polar, checkout, portal, webhooks } from "@polar-sh/better-auth";
import { grantsAccess, periodEndMs, productTier, TIER_RANK } from "@prowl/shared";

// Polyfill Buffer for Convex runtime — @polar-sh/sdk/webhooks uses
// Buffer.from() for webhook signature verification which isn't available
// in Convex's V8 isolate.
if (typeof globalThis.Buffer === "undefined") {
  // Minimal Buffer.from shim — only supports UTF-8 input to base64 output,
  // which is the specific pattern used by @polar-sh/sdk webhook verification.
  globalThis.Buffer = {
    from(input: string, encoding?: string): { toString(enc: string): string } {
      if (encoding && !/^utf-?8$/i.test(encoding)) {
        throw new Error(`Buffer.from shim: unsupported encoding "${encoding}" (only UTF-8 is supported)`);
      }
      const bytes = new TextEncoder().encode(input);
      return {
        toString(enc: string) {
          if (enc === "base64") {
            let binary = "";
            for (const byte of bytes) {
              binary += String.fromCharCode(byte);
            }
            return btoa(binary);
          }
          throw new Error(`Buffer.toString shim: unsupported encoding "${enc}" (only base64 is supported)`);
        },
      };
    },
  } as unknown as typeof Buffer;
}
import { Polar } from "@polar-sh/sdk";
import { components, internal } from "../_generated/api";
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
// One-off 30-day pass. Sold as a Polar order, not a subscription, so it
// arrives through onOrderPaid rather than onSubscriptionCreated.
const SPRINT_PRODUCT_ID = process.env.POLAR_SPRINT_PRODUCT_ID;
const SPRINT_DAYS = 30;

/** The user id Polar carries, across the camelCase/snake_case it has used. */
function externalUserId(sub: SubscriptionPayload): string | undefined {
  return (
    sub.customer?.externalId ??
    sub.customer?.external_id ??
    sub.customerExternalId ??
    sub.customer_external_id
  ) ?? undefined;
}

/**
 * Polar's own clock for this subscription, so the mutations can drop a replay
 * that predates what the row already knows. modified_at is null until
 * something changes it — a fresh subscription.created has only created_at,
 * and a row with no stamp can order nothing.
 */
function orderingStamp(sub: SubscriptionPayload): { subscriptionModifiedAt?: number } {
  const raw = sub.modifiedAt ?? sub.modified_at ?? sub.createdAt ?? sub.created_at;
  if (raw == null) return {};
  // The SDK hands these over as Date objects, and String(date) renders to the
  // second — so stringifying first silently floored the stamp by up to 999ms,
  // while reconcile wrote the same field from an ISO string at full precision.
  // A later webhook could then stamp lower than an earlier reconcile and be
  // dropped as stale: the guard rejecting exactly what it exists to protect.
  const ms = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(ms) ? { subscriptionModifiedAt: ms } : {};
}

/**
 * ctx as a webhook handler actually receives it.
 *
 * GenericCtx's union does not expose runMutation, but at runtime an HTTP route
 * handler's ctx is action-like and has it — hence the `as any` the Polar and
 * onboarding handlers below have used since the first one. Borrowing
 * ActionCtx's signature instead keeps the mutation reference and its arguments
 * type-checked, which on a money path is worth the one extra line. The
 * existing casts are left alone; converting them is not this change's job.
 */
type WebhookCtx = GenericCtx<DataModel> & Pick<ActionCtx, "runMutation" | "runQuery">;

/**
 * The fields this file reads off a Polar subscription payload.
 *
 * Narrower than the SDK's Subscription on purpose — the payload has arrived
 * both camelCase and snake_case across versions, so the reads stay defensive,
 * but naming them keeps a rename in a Polar bump a compile error rather than
 * an undefined that silently leaves a paying customer on free.
 */
type SubscriptionPayload = {
  id: string;
  productId: string;
  /** Polar's lifecycle status. Read by grantsAccess — see finding in review 5. */
  status?: string;
  customerId?: string;
  customer_id?: string;
  cancelAtPeriodEnd?: boolean;
  cancel_at_period_end?: boolean;
  modifiedAt?: string | Date | null;
  modified_at?: string | Date | null;
  createdAt?: string | Date | null;
  created_at?: string | Date | null;
  currentPeriodEnd?: string | Date | null;
  current_period_end?: string | Date | null;
  customerExternalId?: string | null;
  customer_external_id?: string | null;
  customer?: { externalId?: string | null; external_id?: string | null } | null;
};

/**
 * Grant the tier a live Polar subscription pays for.
 *
 * Shared by `subscription.created` and `subscription.active` so that losing
 * either event still gets the customer what they bought. It is only the fast
 * path: tiers.reconcile is what repairs an account whose events never arrived
 * at all, which is how a paying customer sat on free for six months.
 */
async function grantFromSubscription(ctx: GenericCtx<DataModel>, sub: SubscriptionPayload, event: string) {
  const tier = productTier(sub.productId, { pro: PRO_PRODUCT_ID, max: MAX_PRODUCT_ID });
  const userId = externalUserId(sub);
  console.log(`[polar] Subscription ${event}:`, sub.id, "tier:", tier, "userId:", userId);

  if (!tier || !userId) {
    console.error(`[polar] Subscription ${event} not applied — tier:`, tier, "userId:", userId, "sub:", sub.id);
    return;
  }

  // subscription.updated is Polar's catch-all and fires on revoke too, with
  // the same product id. Without this, a revoke's `updated` twin landing after
  // its `revoked` reads as "they are on free, Polar says pro" and hands the
  // tier straight back to a churned customer.
  if (!grantsAccess(sub.status)) {
    console.log(`[polar] Subscription ${event} for ${sub.id} has status ${sub.status} — not granting`);
    return;
  }

  // Polar retries a failed delivery up to ten times with backoff, so events
  // do not arrive in the order they happened. Handing the mutations Polar's
  // own modified_at lets them drop a replay that predates what the row already
  // knows — without it, a stale `created` landing after a cancellation clears
  // it, and the customer is never told when their access stops.
  const ordering = orderingStamp(sub);

  const applied = await (ctx as WebhookCtx).runMutation(internal.tiers.update, {
    userId,
    tier,
    polarCustomerId: sub.customerId ?? sub.customer_id,
    polarSubscriptionId: sub.id,
    ...ordering,
  });
  if (!applied) {
    // The row already holds a newer event for this subscription. Saying "tier
    // updated" here would assert a write that did not happen, on the one path
    // whose logs are what a missed grant gets reconstructed from.
    console.warn(`[polar] Subscription ${event} dropped as stale for user`, userId, "sub:", sub.id);
    return;
  }
  console.log("[polar] Tier updated to", tier, "for user", userId);

  // Both directions, because update() no longer clears the cancellation when
  // the subscription and tier are unchanged. Without the clear branch, a
  // dropped `uncanceled` would leave the row saying "cancelled" forever and
  // the settings page telling a paying customer their access had expired.
  const periodEnd = periodEndMs(sub.currentPeriodEnd ?? sub.current_period_end);
  const cancelling = (sub.cancelAtPeriodEnd ?? sub.cancel_at_period_end) === true;
  if (cancelling && periodEnd !== null) {
    await (ctx as WebhookCtx).runMutation(internal.tiers.markCancelled, {
      userId,
      periodEnd,
      polarSubscriptionId: sub.id,
      ...ordering,
    });
  } else if (cancelling) {
    console.warn(`[polar] Subscription ${event} cancels at period end but gave no usable date:`, sub.id);
  } else {
    await (ctx as WebhookCtx).runMutation(internal.tiers.clearCancellation, {
      userId,
      polarSubscriptionId: sub.id,
      ...ordering,
    });
  }
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
              ...(SPRINT_PRODUCT_ID ? [{ productId: SPRINT_PRODUCT_ID, slug: "sprint" }] : []),
            ],
            successUrl: `${process.env.SITE_URL ?? "https://pagealert.io"}/dashboard/settings?upgraded=true`,
            authenticatedUsersOnly: true,
          }),
          portal(),
          ...(process.env.POLAR_WEBHOOK_SECRET ? [webhooks({
            secret: process.env.POLAR_WEBHOOK_SECRET,

            // Polar sends `created` when the subscription record appears and
            // `active` once it is paid for. Both grant, because either can be
            // the one that goes missing. Whichever lands second re-writes the
            // same tier, and tierAlert stays silent on an unchanged one, so a
            // customer is never announced as a second sale.
            onSubscriptionCreated: async (payload) => {
              await grantFromSubscription(ctx, payload.data, "created");
            },

            onSubscriptionActive: async (payload) => {
              await grantFromSubscription(ctx, payload.data, "active");
            },

            // Polar's catch-all, and the only event an in-place plan change
            // fires: neither created nor active re-fires when someone moves
            // pro → max in the portal. Without this they pay max rates on pro
            // limits until the next morning's reconcile.
            //
            // A downgrade is deliberately not applied here. Reducing a tier on
            // a catch-all event that also fires for cancellations, renewals and
            // past-due would take access away on the strength of whichever
            // payload arrived last; reconcile reports it for a person instead.
            onSubscriptionUpdated: async (payload) => {
              const sub = payload.data as SubscriptionPayload;
              const userId = externalUserId(sub);
              const tier = productTier(sub.productId, { pro: PRO_PRODUCT_ID, max: MAX_PRODUCT_ID });
              if (!userId || !tier) return;

              // Stored tier, not the effective one: a live grant can put a
              // customer at max while their subscription row still says pro,
              // and skipping the write there leaves the row on pro to collapse
              // to free the moment the grant lapses.
              const stored = await (ctx as WebhookCtx).runQuery(internal.tiers.storedTierFor, { userId });
              if (TIER_RANK[stored] >= TIER_RANK[tier]) return;
              await grantFromSubscription(ctx, payload.data, "updated");
            },

            onSubscriptionCanceled: async (payload) => {
              const sub = payload.data as SubscriptionPayload;
              const userId = externalUserId(sub);

              // Don't downgrade tier — user keeps access until period ends.
              // Just mark the subscription as cancelled with the period end date.
              if (userId) {
                const periodEnd = periodEndMs(sub.currentPeriodEnd ?? sub.current_period_end);

                if (periodEnd === null) {
                  console.warn("[polar] Subscription canceled but no periodEnd found:", sub.id, "userId:", userId);
                }

                await (ctx as WebhookCtx).runMutation(internal.tiers.markCancelled, {
                  userId,
                  periodEnd: periodEnd ?? Date.now() + 30 * 24 * 60 * 60 * 1000, // fallback: 30 days

                  polarSubscriptionId: sub.id,
                  // Without a stamp here the ordering guard has nothing to
                  // compare against, and a retried `created` walks straight
                  // over this cancellation.
                  ...orderingStamp(sub),
                });
              }
            },

            // The reverse: a customer who resubscribes before the period ends.
            // Unhandled, the row stayed cancelled and the settings page went on
            // telling a paying customer their access had expired.
            onSubscriptionUncanceled: async (payload) => {
              const sub = payload.data as SubscriptionPayload;
              const userId = externalUserId(sub);
              console.log("[polar] Subscription uncanceled:", sub.id, "userId:", userId);
              if (!userId) return;
              await (ctx as WebhookCtx).runMutation(internal.tiers.clearCancellation, {
                userId,
                polarSubscriptionId: sub.id,
                ...orderingStamp(sub),
              });
            },

            onSubscriptionRevoked: async (payload) => {
              const sub = payload.data as SubscriptionPayload;
              const userId = externalUserId(sub);
              console.log("[polar] Subscription revoked:", sub.id, "userId:", userId);

              if (userId) {
                const applied = await (ctx as WebhookCtx).runMutation(internal.tiers.update, {
                  userId,
                  tier: "free" as const,
                  polarCustomerId: sub.customerId ?? sub.customer_id,
                  polarSubscriptionId: sub.id,
                  ...orderingStamp(sub),
                });
                // The path that takes access away needs the same honesty as
                // the one that grants it: a refused write must not log as done.
                console.log(
                  applied
                    ? `[polar] Tier downgraded to free for user ${userId}`
                    : `[polar] Revoke for ${sub.id} not applied to ${userId} (stale or superseded)`,
                );
              }
            },

            // Fires for every paid order, including subscription renewals, so
            // the product check is what makes this the pass handler and not a
            // second path into the subscription tiers.
            onOrderPaid: async (payload) => {
              const order = payload.data as Record<string, unknown>;
              const productId = (order.productId ?? order.product_id) as string | undefined;
              console.log("[polar] Order paid:", order.id, "product:", productId);

              if (!SPRINT_PRODUCT_ID || productId !== SPRINT_PRODUCT_ID) return;

              const customer = order.customer as Record<string, unknown> | undefined;
              const userId = (customer?.externalId ??
                customer?.external_id ??
                order.customerExternalId ??
                order.customer_external_id) as string | undefined;

              if (!userId) {
                console.error("[polar] Sprint pass paid but no external user id on order", order.id);
                return;
              }

              await (ctx as any).runMutation(internal.tiers.grantPass, {
                userId,
                tier: "sprint" as const,
                days: SPRINT_DAYS,
                orderId: String(order.id),
                polarCustomerId: (order.customerId ?? order.customer_id) as string | undefined,
              });
              console.log("[polar] Sprint pass granted to", userId, "for", SPRINT_DAYS, "days");
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
    databaseHooks: {
      user: {
        create: {
          // Queue the welcome-email sequence as soon as a user is created.
          // The actual sender is gated behind ONBOARDING_EMAILS_ENABLED so
          // this safely lands as wired-but-silent until the kill switch
          // is flipped. See PROWL-038 Phase 4.
          after: async (user) => {
            try {
              // (ctx as any).runMutation — see Polar webhook precedent at
              // line 102 above. The GenericCtx union doesn't expose
              // runMutation in the type, but at runtime in HTTP route
              // handlers ctx is action-like and has it.
              await (ctx as any).runMutation(internal.onboarding.queueWelcomeSequence, {
                userId: user.id,
                email: user.email,
              });
            } catch (e) {
              // Never block signup on onboarding queueing failure.
              console.error("[onboarding] failed to queue welcome sequence:", e);
            }
          },
        },
      },
    },
  } satisfies BetterAuthOptions;
};

export const options = createAuthOptions({} as GenericCtx<DataModel>);

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  return betterAuth(createAuthOptions(ctx));
};
