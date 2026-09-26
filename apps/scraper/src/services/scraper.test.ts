import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
    const status = Number(path.split("/")[2]);
    res.statusCode = status;
    res.end(html(`<p>${FILLER}</p>`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

describe("scrapeUrl block detection by HTTP status", () => {
  // eBay, Vinted and Argos all answer a datacenter IP with a 403 whose text
  // none of the markers match; left unflagged, the scheduler never reaches
  // for the fallback proxy.
  it.each([403, 429])("flags a %i response as blocked", async (status) => {
    const result = await scrapeUrl(`${base}/status/${status}`);
    expect(result.blocked).toBe(true);
    expect(result.blockReason).toContain(String(status));
  });

  // A 503 is as often a site outage as a block, and escalating an outage
  // spends proxy credits that cannot fix it.
  it.each([200, 404, 500, 503])("does not flag a %i response", async (status) => {
    const result = await scrapeUrl(`${base}/status/${status}`);
    expect(result.blocked).toBeUndefined();
  });

  it("judges the page it ended on, not a challenge it passed through", async () => {
    const result = await scrapeUrl(`${base}/challenge`);
    expect(result.blocked).toBeUndefined();
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
