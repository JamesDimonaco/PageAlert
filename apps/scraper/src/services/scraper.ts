import { chromium, type Browser, type Page } from "playwright";
import type { ScrapeResponse } from "@prowl/shared";
import { validateUrlForScraping } from "../utils/url-validation.js";

type LaunchedBrowser = { instance: Browser; userAgent: string };

/**
 * Shared by every caller: scrapes arrive in bursts, and a caller that
 * launched its own browser would leave the others' running unclosed.
 */
let browserLaunch: Promise<LaunchedBrowser> | null = null;

/**
 * Maximum number of concurrent browser contexts. Each one is a live renderer,
 * so this is a memory ceiling and raising it to cover peaks is the wrong
 * trade: a rejection costs one check, an OOM kills the browser and every
 * check in flight with it.
 *
 * Bursts are absorbed by waiting instead. A full extract runs up to 120s
 * against a one-minute cron tick, so several of the scheduler's dispatches
 * overlap, and manual scans share this pool — but they overlap in bursts, not
 * steadily, and a caller that waits a few seconds for a slot beats one that
 * gets an error the scheduler records as a failed check.
 */
const MAX_CONCURRENT_CONTEXTS = 20;
/** Well inside the caller's 90s quick-check and 120s extract timeouts */
const SLOT_WAIT_MS = 20_000;
let activeContexts = 0;

/**
 * Wait for a free context slot, giving up rather than queueing forever.
 * The check and the increment share a tick, so two callers can't take the
 * same slot.
 */
async function acquireContextSlot(): Promise<void> {
  const deadline = Date.now() + SLOT_WAIT_MS;
  while (activeContexts >= MAX_CONCURRENT_CONTEXTS) {
    if (Date.now() >= deadline) {
      throw new Error("Too many concurrent scraping requests. Please try again later.");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  activeContexts++;
}

/** Maximum response body size (5MB) to prevent memory exhaustion */
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;

/** Hard cap on timeout to prevent indefinite resource consumption */
const MAX_TIMEOUT = 60000;

async function getBrowser(relaunched = false): Promise<LaunchedBrowser> {
  const launch = browserLaunch ?? (browserLaunch = launchBrowser());
  let launched: LaunchedBrowser;
  try {
    launched = await launch;
  } catch (error) {
    // Let the next caller retry rather than inherit this failure forever
    if (browserLaunch === launch) browserLaunch = null;
    throw error;
  }
  if (launched.instance.isConnected()) return launched;
  // Crashed or killed. Only the first caller to notice starts the relaunch.
  if (browserLaunch === launch) browserLaunch = null;
  // One that dies straight after launching would otherwise respawn in a loop
  if (relaunched) throw new Error("Browser disconnected right after launch");
  return getBrowser(true);
}

async function launchBrowser(): Promise<LaunchedBrowser> {
  const instance = await chromium.launch({
    // The full browser in new headless mode. The default headless shell
    // sends "HeadlessChrome" in sec-ch-ua on every request.
    channel: "chromium",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      // Prevent the browser from accessing file:// and other dangerous protocols
      "--disable-file-system",
      // Limit process memory
      "--js-flags=--max-old-space-size=256",
    ],
  });
  try {
    // New headless still says "HeadlessChrome" in the user agent. Keep the
    // rest of the real string: a made-up one contradicts the version and
    // platform the engine reports in its client hints, itself a bot signal.
    const probe = await instance.newPage();
    const userAgent = (await probe.evaluate(() => navigator.userAgent)).replace("HeadlessChrome", "Chrome");
    await probe.close();
    return { instance, userAgent };
  } catch (error) {
    // The probe's error is the one worth reporting
    await instance.close().catch(() => {});
    throw error;
  }
}

/** Prefix for failures of the fallback provider itself, as opposed to the site blocking us. */
export const FALLBACK_PROVIDER_ERROR = "Fallback provider error";

type ScrapflyResponse = {
  result?: {
    content?: string;
    success?: boolean;
    status_code?: number;
    error?: { code?: string; message?: string };
  };
  context?: { cost?: { total?: number } };
  message?: string;
};

/**
 * Blocked-site fallback: Scrapfly fetches the page with its anti-bot
 * protection and returns rendered HTML. Null when no key is configured so
 * the caller falls back to a direct fetch. Docs: docs/research/unblocker-providers.md
 */
async function fetchViaUnblocker(url: string, timeout: number): Promise<string | null> {
  const key = process.env.SCRAPFLY_API_KEY;
  if (!key) {
    console.warn("[scraper] Fallback requested but SCRAPFLY_API_KEY not set, using direct connection");
    return null;
  }
  // asp=true lets Scrapfly escalate the proxy pool only when a site needs it,
  // so a plain page costs 6 credits and a protected one up to 30.
  const params = new URLSearchParams({ key, url, render_js: "true", asp: "true" });
  // 45s leaves room for extraction inside the scheduler's 90s budget
  const res = await fetch(`https://api.scrapfly.io/scrape?${params}`, {
    signal: AbortSignal.timeout(Math.min(timeout, 45_000)),
  });
  const body = (await res.json().catch(() => null)) as ScrapflyResponse | null;
  const result = body?.result;
  if (!res.ok || !result || result.success === false || !result.content) {
    const reason = result?.error?.message ?? body?.message ?? (result ? "empty page" : `HTTP ${res.status}`);
    // ERR::ASP::* means Scrapfly reached the site and could not get past its
    // protection: a real block. Anything else is the provider itself failing
    // (bad key, no credits, outage) and must not be blamed on the site.
    if (result?.error?.code?.startsWith("ERR::ASP")) {
      throw new Error(`Site is blocking automated access: ${reason}`);
    }
    throw new Error(`${FALLBACK_PROVIDER_ERROR}: ${reason}`);
  }
  console.log(`[scraper] Fallback fetch ${url}: upstream ${result.status_code}, ${body?.context?.cost?.total ?? "?"} credits`);
  // The HTML is already rendered; running its scripts again against a fresh
  // DOM lets SPA hydration blank the page after we paid for it.
  return result.content.replace(/<script\b[\s\S]*?<\/script>/gi, "");
}

/** Give relative links a real origin when HTML is loaded via setContent. */
function withBaseHref(html: string, url: string): string {
  const base = `<base href="${url.replace(/"/g, "&quot;")}">`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${base}`) : `${base}${html}`;
}

export async function scrapeUrl(
  url: string,
  options?: { timeout?: number; waitFor?: string; retryAttempt?: number; useProxy?: boolean }
): Promise<ScrapeResponse> {
  // SSRF protection: validate URL before making any request
  await validateUrlForScraping(url);

  // Enforce timeout cap
  const timeout = Math.min(options?.timeout ?? 30000, MAX_TIMEOUT);
  const retry = options?.retryAttempt ?? 0;
  const useProxy = options?.useProxy ?? false;

  // Fetched before taking a browser slot: the wait is pure HTTP
  const unblockedHtml = useProxy ? await fetchViaUnblocker(url, timeout) : null;

  // Resource exhaustion protection: limit concurrent contexts
  await acquireContextSlot();

  try {
    const b = await getBrowser();

    const context = await b.instance.newContext({ userAgent: b.userAgent, viewport: { width: 1920, height: 1080 } });

    const page = await context.newPage();

    // Status of the last main-frame document, so a challenge that clears
    // itself and navigates to the real page is judged by where it ended up.
    let documentStatus: number | undefined;
    page.on("response", (response) => {
      if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
        documentStatus = response.status();
      }
    });

    // Intercept all requests: block dangerous protocols and heavy resources
    const BLOCKED_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|mp4|webm)$/i;
    await page.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      try {
        const parsedUrl = new URL(requestUrl);
        // Block non-http(s) protocols (file://, data://, etc.) to prevent SSRF via redirects
        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          return route.abort();
        }
        // Block heavy resources that slow things down and aren't needed for content
        if (BLOCKED_EXTENSIONS.test(parsedUrl.pathname)) {
          return route.abort();
        }
      } catch {
        return route.abort();
      }
      return route.continue();
    });

    try {
      if (unblockedHtml !== null) {
        // Already rendered upstream; load it so the same DOM extraction runs
        await page.setContent(withBaseHref(unblockedHtml, url), { waitUntil: "domcontentloaded", timeout });
      } else {
        // Use domcontentloaded instead of networkidle - much more reliable
        // networkidle waits for zero network connections which many sites never reach
        await page.goto(url, { waitUntil: "domcontentloaded", timeout });

        // Wait for the body to have meaningful content
        await page.waitForFunction(
          () => (document.body?.innerText?.length ?? 0) > 100,
          { timeout: 15000 }
        ).catch(() => {});

        if (options?.waitFor) {
          // Sanitize the waitFor selector to prevent injection
          const safeSelector = options.waitFor.slice(0, 200);
          await page.waitForSelector(safeSelector, { timeout: 10000 }).catch(() => {});
        }

        // Let JS frameworks render — wait longer on retries to give anti-bot challenges time to resolve
        await page.waitForTimeout(retry >= 1 ? 5000 : 3000);
      }

      const title = (await page.title()).slice(0, 500);

      // Scrapfly only returns success once its anti-bot pass got a real page,
      // and real pages embed captcha widgets in forms, so only run our own
      // detector on direct fetches.
      const botCheck = unblockedHtml !== null
        ? { blocked: false as const }
        : blockedByStatus(documentStatus) ?? await detectAntiBot(page);

      const html = await getCleanHtml(page);
      const text = await getTextWithLinks(page);

      // Enforce max response size
      if (html.length > MAX_RESPONSE_SIZE || text.length > MAX_RESPONSE_SIZE) {
        throw new Error("Page content exceeds maximum allowed size");
      }

      return {
        url,
        html: html.slice(0, MAX_RESPONSE_SIZE),
        text: text.slice(0, MAX_RESPONSE_SIZE),
        title,
        scrapedAt: new Date().toISOString(),
        ...(botCheck.blocked ? { blocked: true, blockReason: botCheck.reason } : {}),
        ...(unblockedHtml !== null ? { proxied: true } : {}),
      };
    } finally {
      await context.close();
    }
  } finally {
    activeContexts--;
  }
}

async function getCleanHtml(page: Page): Promise<string> {
  return page.evaluate(() => {
    // Remove scripts, styles, nav, footer, ads
    const selectorsToRemove = [
      "script",
      "style",
      "noscript",
      "nav",
      "footer",
      "header",
      "iframe",
      '[role="navigation"]',
      '[role="banner"]',
      '[role="contentinfo"]',
      ".cookie-banner",
      ".ad",
      ".advertisement",
    ];

    const clone = document.body.cloneNode(true) as HTMLElement;
    selectorsToRemove.forEach((selector) => {
      clone.querySelectorAll(selector).forEach((el) => el.remove());
    });

    return clone.innerHTML;
  });
}

/** Extract text but convert <a> tags to [text](href) format so AI can extract URLs */
async function getTextWithLinks(page: Page): Promise<string> {
  return page.evaluate(() => {
    const selectorsToRemove = [
      "script",
      "style",
      "noscript",
      "nav",
      "footer",
      "header",
      "iframe",
      '[role="navigation"]',
      '[role="banner"]',
      '[role="contentinfo"]',
    ];

    const clone = document.body.cloneNode(true) as HTMLElement;
    selectorsToRemove.forEach((selector) => {
      clone.querySelectorAll(selector).forEach((el) => el.remove());
    });

    // Convert <a> tags to markdown-style links before extracting text
    clone.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      const text = a.textContent?.trim();
      if (!href || !text) return;

      if (!href.trim() || href.trim() === "#") return;
      try {
        // setContent pages have no location; their origin is the injected <base>
        const origin = document.location.href.startsWith("about:") ? document.baseURI : document.location.href;
        const parsed = new URL(href, origin);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
        a.textContent = `[${text}](${parsed.href})`;
      } catch {

        return;
      }
    });

    return clone.innerText.replace(/\n{3,}/g, "\n\n").trim();
  });
}

/**
 * Anti-bot services answer with a 403 whatever the page text says, and their
 * block pages often match none of detectAntiBot's markers. 503 is left out as
 * often a site outage, and 429 as usually our own burst being rate limited:
 * flagging either sends a healthy monitor to the proxy and its 6h interval.
 */
function blockedByStatus(status: number | undefined): { blocked: true; reason: string } | null {
  return status === 403 ? { blocked: true, reason: "HTTP 403" } : null;
}

/**
 * Check if a page is serving an anti-bot challenge instead of real content.
 * High-confidence markers trigger immediately. Ambiguous markers only trigger
 * when the page has very little content (< 500 chars), since real pages can
 * contain phrases like "security check" or "access denied" in their normal content.
 */
export async function detectAntiBot(page: Page): Promise<{ blocked: boolean; reason?: string }> {
  try {
    const result = await page.evaluate(() => {
      const html = document.documentElement.innerHTML.toLowerCase();
      const text = (document.body?.innerText ?? "").toLowerCase();
      const textLen = text.length;

      // Always indicate blocking regardless of page size
      const highConfidence: [string, string][] = [
        ["captcha", "CAPTCHA challenge"],
        ["verify you are human", "Human verification"],
        ["are you a robot", "Bot detection"],
        ["please enable javascript", "JavaScript required"],
        ["checking your browser", "Browser verification"],
        ["enable cookies", "Cookies required"],
      ];

      for (const [marker, reason] of highConfidence) {
        if (html.includes(marker) || text.includes(marker)) {
          return { blocked: true, reason };
        }
      }

      // Only flag these on short pages (< 500 chars) — real product pages
      // can legitimately contain "access denied" or "security check" in content
      if (textLen < 500) {
        const ambiguous: [string, string][] = [
          ["access denied", "Access denied"],
          ["just a moment", "Cloudflare challenge"],
          ["pardon our interruption", "Anti-bot interruption"],
          ["unusual traffic", "Unusual traffic detection"],
          ["security check", "Security check"],
          ["bot detection", "Bot detection"],
        ];

        for (const [marker, reason] of ambiguous) {
          if (html.includes(marker) || text.includes(marker)) {
            return { blocked: true, reason };
          }
        }
      }

      return { blocked: false };
    });
    return result;
  } catch {
    return { blocked: false };
  }
}
