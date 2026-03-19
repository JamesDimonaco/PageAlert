import { chromium, type Browser, type Page } from "playwright";
import type { ScrapeResponse } from "@prowl/shared";

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return browser;
}

export async function scrapeUrl(
  url: string,
  options?: { timeout?: number; waitFor?: string }
): Promise<ScrapeResponse> {
  const timeout = options?.timeout ?? 60000;
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: getRandomUserAgent(),
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();

  // Block heavy resources that slow things down and aren't needed for content
  await page.route("**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,mp4,webm}", (route) =>
    route.abort()
  );

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
      await page.waitForSelector(options.waitFor, { timeout: 10000 }).catch(() => {});
    }

    // Let JS frameworks render
    await page.waitForTimeout(3000);

    const title = await page.title();
    const html = await getCleanHtml(page);
    const text = await getCleanText(page);

    return {
      url,
      html,
      text,
      title,
      scrapedAt: new Date().toISOString(),
    };
  } finally {
    await context.close();
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

async function getCleanText(page: Page): Promise<string> {
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

    return clone.innerText.replace(/\n{3,}/g, "\n\n").trim();
  });
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

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}
