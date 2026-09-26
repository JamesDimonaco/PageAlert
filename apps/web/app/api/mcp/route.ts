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
import { isBlockedError } from "@/convex/shared";
import { extractPage, urlRejection, type ExtractResponse } from "@/lib/scraper-server";
import { logger } from "@/lib/server-logger";

// A first scan (scrape plus AI extract) takes about 25s and is cut off at 110s.
export const maxDuration = 120;

const SITE_URL = "https://pagealert.io";
/** Matches shown from a scan. The dashboard has the rest. */
const MAX_SCAN_MATCHES = 20;

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: formatToolResult(data) }] };
}

function fail(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Convex keeps a ConvexError's message and hides every other one in prod. */
function errorMessage(e: unknown): string {
  if (e instanceof ConvexError) return String(e.data);
  return "Something went wrong on our side. Try again shortly.";
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
const url = z.string().max(2048).describe("The full http(s) URL of the page to watch.");
const prompt = z
  .string()
  .min(1)
  .max(2000)
  .describe("What to look for on the page, in plain words, e.g. 'any hut booking in February under $100'.");

function registerTools(server: McpServer, apiKey: string) {
  server.registerTool(
    "preview_page",
    {
      title: "Preview a page",
      description:
        "Read a page once and show what PageAlert would match on it for this prompt. Saves nothing. " +
        "Use it to check a page is readable and the prompt picks out the right items before creating a monitor.",
      inputSchema: z.object({ url, prompt }),
    },
    async (args) => {
      const rejection = await urlRejection(args.url);
      if (rejection) return fail(rejection);
      const outcome = await extractPage({ url: args.url, prompt: args.prompt });
      if (!outcome.ok) return fail(outcome.error);
      return ok(scanSummary(outcome.data));
    }
  );

  server.registerTool(
    "create_monitor",
    {
      title: "Create a monitor",
      description:
        "Start watching a page. PageAlert checks it on a schedule and alerts the user by their usual channels " +
        "(email, Telegram, Discord, push) when something matching the prompt appears. Runs the first scan " +
        "before returning, which takes up to a minute. The user's plan limits how many monitors they can " +
        "have and how often they are checked; a faster interval than the plan allows is lowered to the fastest it does.",
      inputSchema: z.object({
        url,
        prompt,
        name: z.string().min(1).max(200).describe("A short name the user will recognise in alerts."),
        checkInterval: intervals.optional().describe("How often to check. Defaults to 1h."),
      }),
    },
    async (args) => {
      const rejection = await urlRejection(args.url);
      if (rejection) return fail(rejection);

      let monitorId;
      try {
        monitorId = await convex.mutation(api.mcp.createMonitor, { apiKey, ...args });
      } catch (e) {
        return fail(errorMessage(e));
      }
      const dashboardUrl = `${SITE_URL}/dashboard/monitors/${monitorId}`;

      const outcome = await extractPage({ url: args.url, prompt: args.prompt, name: args.name });
      try {
        if (!outcome.ok) {
          await convex.mutation(api.mcp.saveScanError, { apiKey, id: monitorId, error: outcome.error });
          // Same split as saveScanError: a block keeps the monitor and retries
          // through the proxy, anything else leaves it in error.
          const retrying = isBlockedError(outcome.error);
          return ok({
            monitorId,
            dashboardUrl,
            status: retrying ? "retrying" : "error",
            firstScan: {
              error: outcome.error,
              next: retrying
                ? "The site blocked the first scan. The monitor is kept and will retry through a proxy."
                : "The first scan failed. The user can fix the monitor or retry it from the dashboard.",
            },
          });
        }

        const summary = scanSummary(outcome.data);
        if (!summary.readable) {
          const reason = summary.notices[0] ?? "Page appears inaccessible - no data could be extracted";
          await convex.mutation(api.mcp.saveScanError, { apiKey, id: monitorId, error: reason });
          return ok({ monitorId, dashboardUrl, status: "error", firstScan: summary });
        }

        await convex.mutation(api.mcp.saveScanResult, {
          apiKey,
          id: monitorId,
          schema: outcome.data.schema,
          matches: outcome.data.matches ?? [],
          contentFingerprint: outcome.data.contentHash,
        });
        return ok({ monitorId, dashboardUrl, status: "active", firstScan: summary });
      } catch (e) {
        return fail(`The monitor was created (${dashboardUrl}) but saving its first scan failed: ${errorMessage(e)}`);
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
        return fail(errorMessage(e));
      }
    }
  );

  server.registerTool(
    "get_matches",
    {
      title: "Get matches",
      description: "The most recent items that matched a monitor's prompt, newest first, with when each matched.",
      inputSchema: z.object({
        monitorId: z.string().describe("The id from list_monitors or create_monitor."),
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
        return fail(errorMessage(e));
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
  const apiKey = bearerToken(request);
  const owner = apiKey ? await convex.mutation(api.apiKeys.verify, { key: apiKey }) : null;
  if (!apiKey || !owner) {
    return Response.json(
      { error: "Send a PageAlert API key as 'Authorization: Bearer pa_live_…'. Create one in Settings → API." },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="pagealert"' } }
    );
  }

  const response = await createMcpHandler((server) => registerTools(server, apiKey), {
    serverInfo: { name: "pagealert", version: "1.0.0" },
    onEvent: (event) => {
      if (event.type === "ERROR") logger.error("mcp: error", { userId: owner.userId });
    },
  })(request);
  after(() => logger.flush());
  return response;
}

export { handler as GET, handler as POST, handler as DELETE };
