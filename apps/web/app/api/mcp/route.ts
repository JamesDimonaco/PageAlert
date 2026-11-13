import { after } from "next/server";
import { createMcpHandler } from "mcp-handler";
import type { McpServer } from "@modelcontextprotocol/server";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { z } from "zod";
import {
  DEFAULT_AGENT_MATCHES,
  MAX_AGENT_MATCHES,
  formatToolResult,
  isUnreadableScan,
  toAgentItem,
  toAgentNotices,
} from "@prowl/shared";
import { api } from "@/convex/_generated/api";
import type { ToolError } from "@/convex/mcp";
import { isBlockedError } from "@/convex/shared";
import { extractPage, urlRejection, type ExtractResponse } from "@/lib/scraper-server";
import { logger } from "@/lib/server-logger";

// A first scan (scrape plus AI extract) takes about 25s.
export const maxDuration = 120;
/**
 * create_monitor has already inserted the monitor when the scan starts, and a
 * function killed at maxDuration would leave it in "scanning", which the
 * scheduler never picks up. This leaves room for the saves either side.
 */
const FIRST_SCAN_TIMEOUT_MS = 80_000;

const SITE_URL = "https://pagealert.io";
/** Matches shown from a scan. The dashboard has the rest. */
const MAX_SCAN_MATCHES = 20;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: formatToolResult(data) }] };
}

/** Every tool fails the same way, so an agent can act on the code. See ToolError. */
function fail(error: ToolError): ToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify(error) }] };
}

/** Convex keeps a ConvexError's data and hides every other error in prod. */
function convexFailure(e: unknown): ToolError {
  if (e instanceof ConvexError && typeof e.data === "object" && e.data !== null) return e.data as ToolError;
  if (e instanceof ConvexError) return { code: "failed", message: String(e.data), retry: false };
  return { code: "failed", message: "Something went wrong on our side. Try again shortly.", retry: true };
}

function invalidUrl(message: string): ToolError {
  return { code: "invalid_url", message, retry: false };
}

function scanSummary(data: ExtractResponse) {
  const totalItems = data.totalItems ?? data.schema?.items?.length ?? 0;
  return {
    readable: !isUnreadableScan({ confidence: data.schema?.insights?.confidence, totalItems }),
    totalItems,
    matches: (data.matches ?? [])
      .slice(0, MAX_SCAN_MATCHES)
      .map(toAgentItem)
      .filter((item) => item !== null),
    notices: toAgentNotices(data.schema?.insights?.notices),
  };
}

const intervals = z.enum(["5m", "15m", "30m", "1h", "6h", "24h"]);
const monitorId = z.string().describe("The id from list_monitors or create_monitor.");
const alertOn = z
  .object({
    backInStock: z.boolean().optional().describe("Alert when the product goes from out of stock to in stock."),
    priceDrop: z.boolean().optional().describe("Alert on any price drop. Not with priceBelow."),
    priceBelow: z
      .object({
        amount: z.number().int().positive().describe("In minor units: 9500 for NZ$95.00."),
        currency: z.string().length(3).describe("ISO 4217 code, e.g. NZD."),
      })
      .optional()
      .describe("Alert when the price falls below this target. Not with priceDrop."),
  })
  .describe(
    "Stock and price alerts. They run only on a product page; on a listing the result says so. " +
      "Send {} to turn them off."
  );
const url = z.string().max(2048).describe("The full http(s) URL of the page to watch.");
const prompt = z
  .string()
  .min(1)
  .max(2000)
  .describe("What to look for on the page, in plain words, e.g. 'any hut booking in February under $100'.");

/** What saveScanError will have done with the monitor, in words for the agent. */
function afterFailedScan(error: string) {
  return isBlockedError(error)
    ? { status: "retrying", next: "The site blocked the first scan. The monitor is kept and will retry through a proxy." }
    : { status: "error", next: "The first scan failed. The user can fix the monitor or retry it from the dashboard." };
}

function registerTools(server: McpServer, convex: ConvexHttpClient, apiKey: string, userId: string) {
  server.registerTool(
    "preview_page",
    {
      title: "Preview a page",
      description:
        "Read a page once and show what PageAlert would match on it for this prompt. Saves nothing. " +
        "Use it to check a page is readable and the prompt picks out the right items before creating a monitor. " +
        "If the site blocks the read, it tries once through a proxy, up to 5 times a day per user.",
      inputSchema: z.object({ url, prompt }),
    },
    async (args) => {
      const rejection = await urlRejection(args.url);
      if (rejection) return fail(invalidUrl(rejection));
      let outcome = await extractPage({ url: args.url, prompt: args.prompt, userId });
      if (!outcome.ok && isBlockedError(outcome.error)) {
        let claim;
        try {
          claim = await convex.mutation(api.mcp.claimPreviewProxy, { apiKey });
        } catch (e) {
          return fail(convexFailure(e));
        }
        if (!claim.granted) {
          return fail({
            code: "blocked",
            message: `${outcome.error}. ${claim.reason} A monitor on this page would still retry through the proxy.`,
            retry: false,
          });
        }
        outcome = await extractPage({ url: args.url, prompt: args.prompt, userId, useProxy: true });
      }
      if (!outcome.ok) {
        return fail(
          isBlockedError(outcome.error)
            ? { code: "blocked", message: `${outcome.error}, even through the proxy.`, retry: false }
            : { code: "failed", message: outcome.error, retry: true }
        );
      }
      return ok(scanSummary(outcome.data));
    }
  );

  server.registerTool(
    "create_monitor",
    {
      title: "Create a monitor",
      description:
        "Start watching a page. PageAlert checks it on a schedule and alerts the user by their usual channels " +
        "(email, Telegram, push) when something matching the prompt appears. Runs the first scan " +
        "before returning, which takes up to a minute. The user's plan limits how many monitors they can " +
        "have and how often they are checked; a faster interval than the plan allows is lowered to the fastest it does.",
      inputSchema: z.object({
        url,
        prompt,
        name: z.string().min(1).max(200).describe("A short name the user will recognise in alerts."),
        checkInterval: intervals.optional().describe("How often to check. Defaults to 1h."),
        alertOn: alertOn.optional().describe("Stock and price alerts. Left out, they are guessed from the prompt."),
      }),
    },
    async (args) => {
      const rejection = await urlRejection(args.url);
      if (rejection) return fail(invalidUrl(rejection));

      let monitorId;
      try {
        monitorId = await convex.mutation(api.mcp.createMonitor, { apiKey, ...args });
      } catch (e) {
        return fail(convexFailure(e));
      }
      const dashboardUrl = `${SITE_URL}/dashboard/monitors/${monitorId}`;

      const outcome = await extractPage({ url: args.url, prompt: args.prompt, name: args.name, userId }, FIRST_SCAN_TIMEOUT_MS);
      try {
        if (!outcome.ok) {
          await convex.mutation(api.mcp.saveScanError, { apiKey, id: monitorId, error: outcome.error });
          const { status, next } = afterFailedScan(outcome.error);
          return ok({ monitorId, dashboardUrl, status, firstScan: { error: outcome.error, next } });
        }

        const summary = scanSummary(outcome.data);
        if (!summary.readable) {
          const reason = summary.notices[0] ?? "Page appears inaccessible - no data could be extracted";
          await convex.mutation(api.mcp.saveScanError, { apiKey, id: monitorId, error: reason });
          const { status, next } = afterFailedScan(reason);
          return ok({ monitorId, dashboardUrl, status, firstScan: { ...summary, next } });
        }

        const { note } = await convex.mutation(api.mcp.saveScanResult, {
          apiKey,
          id: monitorId,
          schema: outcome.data.schema,
          matches: outcome.data.matches ?? [],
          contentFingerprint: outcome.data.contentHash,
        });
        return ok({ monitorId, dashboardUrl, status: "active", firstScan: summary, ...(note ? { note } : {}) });
      } catch (e) {
        // Get it out of "scanning", where nothing would ever check it again.
        await convex
          .mutation(api.mcp.saveScanError, { apiKey, id: monitorId, error: "Saving the first scan failed" })
          .catch(() => {});
        const { message } = convexFailure(e);
        return fail({
          code: "failed",
          message: `The monitor was created (${dashboardUrl}) but saving its first scan failed: ${message}`,
          retry: false,
        });
      }
    }
  );

  server.registerTool(
    "list_monitors",
    {
      title: "List monitors",
      description:
        "The user's monitors, newest first, up to 50. neverSucceeded means PageAlert has never read the page " +
        "successfully, which usually means the monitor needs fixing.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        return ok(await convex.query(api.mcp.listMonitors, { apiKey }));
      } catch (e) {
        return fail(convexFailure(e));
      }
    }
  );

  server.registerTool(
    "get_matches",
    {
      title: "Get matches",
      description: "The most recent items that matched a monitor's prompt, newest first, with when each matched.",
      inputSchema: z.object({
        monitorId,
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_AGENT_MATCHES)
          .optional()
          .describe(`How many to return. Defaults to ${DEFAULT_AGENT_MATCHES}.`),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        return ok(await convex.query(api.mcp.getMatches, { apiKey, ...args }));
      } catch (e) {
        return fail(convexFailure(e));
      }
    }
  );

  server.registerTool(
    "update_monitor",
    {
      title: "Update a monitor",
      description:
        "Change a monitor's name, prompt, check interval or stock and price alerts, or pause and resume it. " +
        "Send only what changes. The URL can't change: delete the monitor and create a new one. " +
        "A new prompt takes effect at the next full read of the page, as in the web app. " +
        "A faster interval than the plan allows is lowered to the fastest it does.",
      inputSchema: z.object({
        monitorId,
        name: z.string().min(1).max(200).optional(),
        prompt: prompt.optional(),
        checkInterval: intervals.optional(),
        alertOn: alertOn.optional(),
        paused: z.boolean().optional().describe("true pauses checks and alerts; false resumes them."),
        url: z.string().optional().describe("Not allowed. Present only so the refusal can say why."),
      }),
      annotations: { idempotentHint: true },
    },
    async (args) => {
      try {
        return ok(await convex.mutation(api.mcp.updateMonitor, { apiKey, ...args }));
      } catch (e) {
        return fail(convexFailure(e));
      }
    }
  );

  server.registerTool(
    "delete_monitor",
    {
      title: "Delete a monitor",
      description: "Delete a monitor and its history for good. Confirm with the user first.",
      inputSchema: z.object({ monitorId }),
      annotations: { destructiveHint: true },
    },
    async (args) => {
      try {
        return ok(await convex.mutation(api.mcp.deleteMonitor, { apiKey, ...args }));
      } catch (e) {
        return fail(convexFailure(e));
      }
    }
  );
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] ?? null;
}

async function handler(request: Request): Promise<Response> {
  // Per request: a ConvexHttpClient runs its mutations one at a time, so a
  // shared one would queue every agent on this instance behind each other.
  const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  const apiKey = bearerToken(request);
  const owner = apiKey ? await convex.mutation(api.apiKeys.verify, { key: apiKey }) : null;
  if (!apiKey || !owner) {
    return Response.json(
      { error: "Send a PageAlert API key as 'Authorization: Bearer pa_live_…'. Create one in Settings → MCP." },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="pagealert"' } }
    );
  }

  const response = await createMcpHandler((server) => registerTools(server, convex, apiKey, owner.userId), {
    serverInfo: { name: "pagealert", version: "1.0.0" },
    onEvent: (event) => {
      if (event.type === "ERROR") {
        logger.error("mcp: error", {
          userId: owner.userId,
          error: event.error instanceof Error ? event.error.message : event.error,
          context: event.context,
        });
      }
    },
  })(request);
  after(() => logger.flush());
  return response;
}

export { handler as GET, handler as POST, handler as DELETE };
