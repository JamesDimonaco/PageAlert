/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as account from "../account.js";
import type * as admin from "../admin.js";
import type * as adminEmails from "../adminEmails.js";
import type * as adminMonitors from "../adminMonitors.js";
import type * as anonymous from "../anonymous.js";
import type * as crons from "../crons.js";
import type * as discord from "../discord.js";
import type * as emailEvents from "../emailEvents.js";
import type * as emails from "../emails.js";
import type * as http from "../http.js";
import type * as logs from "../logs.js";
import type * as monitors from "../monitors.js";
import type * as notificationSettings from "../notificationSettings.js";
import type * as notifications from "../notifications.js";
import type * as onboarding from "../onboarding.js";
import type * as push from "../push.js";
import type * as pushSubscriptions from "../pushSubscriptions.js";
import type * as reviews from "../reviews.js";
import type * as scheduler from "../scheduler.js";
import type * as shared from "../shared.js";
import type * as telegram from "../telegram.js";
import type * as telegramWebhook from "../telegramWebhook.js";
import type * as tiers from "../tiers.js";
import type * as userNotifications from "../userNotifications.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  account: typeof account;
  admin: typeof admin;
  adminEmails: typeof adminEmails;
  adminMonitors: typeof adminMonitors;
  anonymous: typeof anonymous;
  crons: typeof crons;
  discord: typeof discord;
  emailEvents: typeof emailEvents;
  emails: typeof emails;
  http: typeof http;
  logs: typeof logs;
  monitors: typeof monitors;
  notificationSettings: typeof notificationSettings;
  notifications: typeof notifications;
  onboarding: typeof onboarding;
  push: typeof push;
  pushSubscriptions: typeof pushSubscriptions;
  reviews: typeof reviews;
  scheduler: typeof scheduler;
  shared: typeof shared;
  telegram: typeof telegram;
  telegramWebhook: typeof telegramWebhook;
  tiers: typeof tiers;
  userNotifications: typeof userNotifications;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
};
