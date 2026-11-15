/**
 * Full page read on one model, over pages scraped once and cached.
 *
 *   EVAL_LEDGER=<ledger.jsonl> npx tsx --env-file=.env scripts/eval-extract.ts <model|scrape> <pages.json> <outDir> [maxUsd]
 *
 * pages.json is a JSON array of { id, name, url, prompt }. "scrape" only
 * fills <outDir>/pages/<id>.txt with Playwright, which costs no AI money.
 * A model run reads those files and writes <outDir>/extract-<model>.jsonl. Billed.
 */
import fs from "node:fs";
import path from "node:path";
import { total$, tracked } from "./eval-spend.js";
import { extractWithAI } from "../src/services/extractor.js";
import { scrapeUrl } from "../src/services/scraper.js";
import type { ClaudeModel } from "../src/services/model-settings.js";

const [mode, pagesPath, outDir, maxUsdArg] = process.argv.slice(2) as [ClaudeModel | "scrape", string, string, string?];
if (!mode || !pagesPath || !outDir) throw new Error("Usage: eval-extract.ts <model|scrape> <pages.json> <outDir> [maxUsd]");

interface Page { id: string; name: string; url: string; prompt: string }
const pages = JSON.parse(fs.readFileSync(pagesPath, "utf8")) as Page[];
const textPath = (page: Page) => path.join(outDir, "pages", `${page.id}.txt`);

if (mode === "scrape") {
  fs.mkdirSync(path.join(outDir, "pages"), { recursive: true });
  const log = path.join(outDir, "scrape.jsonl");
  for (const page of pages) {
    if (fs.existsSync(textPath(page))) continue;
    const start = Date.now();
    try {
      const scraped = await scrapeUrl(page.url, { timeout: 45_000 });
      if (!scraped.blocked && scraped.text) fs.writeFileSync(textPath(page), scraped.text);
      fs.appendFileSync(log, JSON.stringify({ id: page.id, ms: Date.now() - start, blocked: scraped.blocked, blockReason: scraped.blockReason, chars: scraped.text.length }) + "\n");
    } catch (error) {
      fs.appendFileSync(log, JSON.stringify({ id: page.id, ms: Date.now() - start, error: (error as Error).message }) + "\n");
    }
  }
  // The scraper keeps a shared browser open and exports no way to close it.
  process.exit(0);
} else {
  const outPath = path.join(outDir, `extract-${mode}.jsonl`);
  const maxUsd = maxUsdArg ? Number(maxUsdArg) : Infinity;
  const startTotal = total$();
  const runnable = pages.filter((p) => fs.existsSync(textPath(p)));
  let next = 0;
  const worker = async () => {
    while (next < runnable.length) {
      if (total$() - startTotal >= maxUsd) return;
      const page = runnable[next++]!;
      const text = fs.readFileSync(textPath(page), "utf8");
      const run = await tracked(`extract:${mode}:${page.id}`, () => extractWithAI(text, page.prompt, page.url, page.name, undefined, mode));
      const call = run.calls.at(-1);
      fs.appendFileSync(
        outPath,
        JSON.stringify({
          id: page.id,
          model: mode,
          chars: text.length,
          error: run.error,
          stopReason: call?.stopReason ?? null,
          blockTypes: call?.blockTypes ?? [],
          usd: run.calls.reduce((s, c) => s + c.usd, 0),
          ms: run.calls.reduce((s, c) => s + c.ms, 0),
          inputTokens: call?.inputTokens ?? 0,
          outputTokens: call?.outputTokens ?? 0,
          schema: run.value?.schema,
          matches: run.value?.matches,
        }) + "\n"
      );
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  console.log(`${mode}: run spent $${(total$() - startTotal).toFixed(3)}, ledger total $${total$().toFixed(3)}`);
}
