import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Every scrape launches or reuses a real browser and then waits 3s for
// the page's scripts, so vitest's 5s default is not enough.
vi.setConfig({ testTimeout: 30_000 });

// The SSRF guard rejects loopback, which is the only place a test server can live.
vi.mock("../utils/url-validation.js", () => ({ validateUrlForScraping: async () => {} }));

const { scrapeUrl } = await import("./scraper.js");

// Long enough to clear the scraper's "page has rendered" wait, and free of
// every text marker detectAntiBot looks for, so only the status can flag it.
const FILLER = "Listing results for your search. ".repeat(10);

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    const html = (body: string) => `<html><head><title>t</title></head><body>${body}</body></html>`;
    res.setHeader("content-type", "text/html");

    if (path === "/headers") {
      res.end(html(`<p>ua=${req.headers["user-agent"]}</p><p>ch=${req.headers["sec-ch-ua"]}</p><p>${FILLER}</p>`));
      return;
    }
    // A challenge that clears itself: 403 first, then a script navigates to the real page.
    if (path === "/challenge") {
      res.statusCode = 403;
      res.end(html(`<p>${FILLER}</p><script>setTimeout(() => location.replace("/status/200"), 200)</script>`));
      return;
    }
    // A real shop page: a reCAPTCHA under its sign-up form and a <noscript>
    // nag in the markup, neither of which makes it a challenge.
    if (path === "/shop-with-recaptcha") {
      res.end(html(`<noscript>Please enable JavaScript to use this site.</noscript><p>${FILLER.repeat(2)}</p>`
        + `<form><p>This site is protected by reCAPTCHA.</p></form><script>window.grecaptchaSiteKey = "x";</script>`));
      return;
    }
    if (path === "/amazon-captcha") {
      res.end(html(`<form action="/errors/validateCaptcha"><p>Type the characters you see in this image.</p></form>`));
      return;
    }
    // A WAF that hangs up instead of answering
    if (path === "/drop") {
      req.socket.destroy();
      return;
    }
    // Anything else, like the favicon the full browser asks for, is a 404:
    // a NaN status throws inside the server and takes the test worker down.
    const status = Number(path.split("/")[2]);
    res.statusCode = Number.isInteger(status) ? status : 404;
    res.end(html(`<p>${FILLER}</p>`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("scrapeUrl block detection by HTTP status", () => {
  // eBay, Vinted and Argos all answer a datacenter IP with a 403 whose text
  // none of the markers match; left unflagged, the scheduler never reaches
  // for the fallback proxy.
  it("flags a 403 response as blocked", async () => {
    const result = await scrapeUrl(`${base}/status/403`);
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toBe("HTTP 403");
  });

  // A 503 is as often a site outage as a block, and escalating an outage
  // spends proxy credits that cannot fix it. A 429 is usually our own burst
  // being rate limited, and one success through the proxy marks the monitor
  // proxy-preferred, moving it to the 6h interval.
  it.each([200, 429, 500, 503])("does not flag a %i response", async (status) => {
    const result = await scrapeUrl(`${base}/status/${status}`);
    expect(result.blocked).toBeUndefined();
  });

  // Prod, 15/11/2026: a removed listing's 404 page was handed to the AI,
  // which found nothing and called it a success. The owner was never told.
  it.each([404, 410])("fails a %i as a page the shop says is gone", async (status) => {
    await expect(scrapeUrl(`${base}/status/${status}`)).rejects.toThrow(`Page not found (HTTP ${status})`);
  });

  it("judges the page it ended on, not a challenge it passed through", async () => {
    const result = await scrapeUrl(`${base}/challenge`);
    expect(result.blocked).toBeUndefined();
  });
});

// Prod, 15/11/2026: a removed Warehouse listing came back from Scrapfly as
// "Fallback provider error". That pinged "Scrapfly is failing" every hour,
// and the owner was told the proxy broke rather than that the page is gone.
describe("scrapeUrl through the fallback proxy", () => {
  it.each([404, 410])("names a page the shop says is gone (%i), not the provider", async (status) => {
    vi.stubEnv("SCRAPFLY_API_KEY", "test");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      result: {
        success: false,
        status_code: status,
        content: "<title>404 Page Not Found</title>",
        error: { code: "ERR::SCRAPE::BAD_UPSTREAM_RESPONSE", message: `The website you target respond with an unexpected status code (>400) - respond with ${status}` },
      },
    }, { status: 422 })));
    try {
      const failure = scrapeUrl("https://shop.test/gone", { useProxy: true });
      await expect(failure).rejects.toThrow(`Page not found (HTTP ${status})`);
      await expect(failure).rejects.not.toThrow("Fallback provider error");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  // Scrapfly can pass the shop's answer through as a success. Read as a
  // page, a 404 is an empty success, which is the bug this guards.
  it("names a gone page that Scrapfly returns as a success", async () => {
    vi.stubEnv("SCRAPFLY_API_KEY", "test");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ result: { success: true, status_code: 404, content: "<title>404</title>" } })));
    try {
      await expect(scrapeUrl("https://shop.test/gone", { useProxy: true })).rejects.toThrow("Page not found (HTTP 404)");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  // Any other upstream status is still Scrapfly's problem to report.
  it("keeps other provider failures as provider errors", async () => {
    vi.stubEnv("SCRAPFLY_API_KEY", "test");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ result: { success: false, status_code: 500, error: { code: "ERR::SCRAPE::BAD_UPSTREAM_RESPONSE", message: "respond with 500" } } }, { status: 422 })));
    try {
      await expect(scrapeUrl("https://shop.test/down", { useProxy: true })).rejects.toThrow("Fallback provider error: respond with 500");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe("scrapeUrl block detection by page content", () => {
  // Matching "captcha" anywhere in the source failed real shops in seconds
  // and parked monitors that would have worked.
  it("does not flag a real page that carries a reCAPTCHA or a noscript nag", async () => {
    const result = await scrapeUrl(`${base}/shop-with-recaptcha`);
    expect(result.blocked).toBeUndefined();
  });

  // Longer timeout: a near-empty page waits out the scraper's 15s render wait
  it("flags Amazon's captcha page", async () => {
    const result = await scrapeUrl(`${base}/amazon-captcha`);
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toBe("CAPTCHA challenge");
  }, 60_000);
});

describe("scrapeUrl connection drops", () => {
  // Thrown as a generic error, a dropped connection never escalated to the
  // proxy, so a site behind such a WAF retried direct until it parked.
  it("reports a dropped connection as a block", async () => {
    const result = await scrapeUrl(`${base}/drop`);
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toMatch(/^Connection dropped/);
  });
});

describe("scrapeUrl browser fingerprint", () => {
  // The old headless shell announced itself in both headers, and a spoofed
  // user agent contradicted the real engine version in sec-ch-ua.
  it("does not announce a headless browser", async () => {
    const { text } = await scrapeUrl(`${base}/headers`);
    expect(text).toContain("ua=Mozilla/5.0");
    expect(text).not.toMatch(/headless/i);
  });

  it("sends a user agent that matches the engine's own client hints", async () => {
    const { text } = await scrapeUrl(`${base}/headers`);
    const uaVersion = text.match(/Chrome\/(\d+)/)?.[1];
    const hintVersion = text.match(/"Chromium";v="(\d+)"/)?.[1];
    expect(uaVersion).toBeDefined();
    expect(uaVersion).toBe(hintVersion);
  });
});

describe("scrapeUrl browser launch", () => {
  // Checks arrive in bursts. Before the launch was shared, each scrape that
  // found no browser launched its own and all but the last were never
  // closed: whole Chromium processes left running on Railway.
  it("launches one browser for concurrent scrapes on a cold start", async () => {
    vi.resetModules();
    const fresh = await import("./scraper.js");
    const launch = vi.spyOn(chromium, "launch");
    try {
      await Promise.all([1, 2, 3].map(() => fresh.scrapeUrl(`${base}/status/200`)));
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      launch.mockRestore();
    }
  });
});
