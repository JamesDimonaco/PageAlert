import { chromium, type Browser, type Page } from "playwright";
import type { ScrapeResponse } from "@prowl/shared";
import { validateUrlForScraping } from "../utils/url-validation.js";

let browser: Browser | null = null;

/** Maximum number of concurrent browser contexts to prevent resource exhaustion */
const MAX_CONCURRENT_CONTEXTS = 10;
let activeContexts = 0;

/** Maximum response body size (5MB) to prevent memory exhaustion */
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;

/** Hard cap on timeout to prevent indefinite resource consumption */
const MAX_TIMEOUT = 60000;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
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
  }
  return browser;
}

/**
 * Get proxy configuration if available.
 * Supports PROXY_URL env var in format: http://user:pass@host:port
 * Works with residential proxy providers like Bright Data, Oxylabs, SmartProxy, etc.
 */
function getProxyConfig(): { server: string; username?: string; password?: string } | null {
  const proxyUrl = process.env.PROXY_URL;
  if (!proxyUrl) return null;
  try {
    const parsed = new URL(proxyUrl);
    return {
      server: `${parsed.protocol}//${parsed.host}`,
      username: parsed.username || undefined,
      password: parsed.password || undefined,
    };
  } catch {
    console.warn("[scraper] Invalid PROXY_URL format, ignoring");
    return null;
  }
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

  // Resource exhaustion protection: limit concurrent contexts
  if (activeContexts >= MAX_CONCURRENT_CONTEXTS) {
    throw new Error("Too many concurrent scraping requests. Please try again later.");
  }
  activeContexts++;

  try {
    const b = await getBrowser();

    // Vary scraping strategy on retries to bypass anti-bot
    const isMobileRetry = retry >= 2;
    const ua = isMobileRetry ? getMobileUserAgent() : getRandomUserAgent();
    const viewport = isMobileRetry
      ? { width: 390, height: 844 }  // iPhone viewport
      : { width: 1920, height: 1080 };

    // Use proxy when requested and configured
    const proxyConfig = useProxy ? getProxyConfig() : null;
    if (useProxy && !proxyConfig) {
      console.warn("[scraper] Proxy requested but PROXY_URL not configured, using direct connection");
    }

    const context = await b.newContext({
      userAgent: ua,
      viewport,
      ...(proxyConfig ? { proxy: proxyConfig } : {}),
    });

    const page = await context.newPage();

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

      const title = (await page.title()).slice(0, 500);

      // Check for anti-bot challenges before extracting content
      const botCheck = await detectAntiBot(page);

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
        ...(proxyConfig ? { proxied: true } : {}),
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
        const parsed = new URL(href, document.location.href);
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

const userAgents = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

function getRandomUserAgent(): string {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

const mobileUserAgents = [
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.103 Mobile/15E148 Safari/604.1",
];

function getMobileUserAgent(): string {
  return mobileUserAgents[Math.floor(Math.random() * mobileUserAgents.length)];
}
