/**
 * Product search on one model.
 *
 *   EVAL_LEDGER=<ledger.jsonl> npx tsx --env-file=.env scripts/eval-search.ts <model> <queries.json> <out.jsonl> [maxUsd]
 *
 * queries.json is a JSON array of { query, region }. Writes one line per
 * query with the listings, how it failed, cost and time. Stops starting
 * queries once this run has spent maxUsd. Every query is billed, web search included.
 */
import fs from "node:fs";
import type { SearchRegion } from "@prowl/shared";
import { total$, tracked } from "./eval-spend.js";
import { findListings, searchFailureReason } from "../src/services/find-listings.js";
import type { ClaudeModel } from "../src/services/model-settings.js";

const [model, queriesPath, outPath, maxUsdArg] = process.argv.slice(2) as [ClaudeModel, string, string, string?];
if (!model || !queriesPath || !outPath) throw new Error("Usage: eval-search.ts <model> <queries.json> <out.jsonl> [maxUsd]");

const queries = JSON.parse(fs.readFileSync(queriesPath, "utf8")) as { query: string; region: SearchRegion }[];
const maxUsd = maxUsdArg ? Number(maxUsdArg) : Infinity;
const startTotal = total$();

let next = 0;
async function worker() {
  while (next < queries.length) {
    if (total$() - startTotal >= maxUsd) return;
    const { query, region } = queries[next++]!;
    const start = Date.now();
    let reason: string | undefined;
    const run = await tracked(`search:${model}:${region}:${query}`, () =>
      findListings(query, region, undefined, undefined, model).catch((error: unknown) => {
        reason = searchFailureReason(error);
        throw error;
      })
    );
    fs.appendFileSync(
      outPath,
      JSON.stringify({
        query,
        region,
        model,
        secs: (Date.now() - start) / 1000,
        listings: run.value ?? null,
        failure: reason ?? null,
        error: run.error,
        calls: run.calls.length,
        searches: run.calls.reduce((s, c) => s + c.searches, 0),
        usd: run.calls.reduce((s, c) => s + c.usd, 0),
        inputTokens: run.calls.reduce((s, c) => s + c.inputTokens, 0),
        outputTokens: run.calls.reduce((s, c) => s + c.outputTokens, 0),
        stopReasons: run.calls.map((c) => c.stopReason),
        ...(run.error || run.value?.length === 0 ? { text: run.calls.at(-1)?.text.slice(0, 1500) } : {}),
      }) + "\n"
    );
  }
}

await Promise.all(Array.from({ length: 4 }, worker));
console.log(`${model}: run spent $${(total$() - startTotal).toFixed(3)}, ledger total $${total$().toFixed(3)}`);
