/**
 * Replay stored scoring batches through scoreCandidates on one model.
 *
 *   EVAL_LEDGER=<ledger.jsonl> npx tsx --env-file=.env scripts/eval-scorer.ts <model> <sample.json> <out.jsonl> [limit] [maxUsd]
 *
 * The sample is a JSON array of { batchId, prompt, name, candidates }. Each
 * batch writes one line: the scores, the calls it made, and how it failed.
 * Stops starting batches once this run has spent maxUsd. Billed.
 */
import fs from "node:fs";
import { total$, tracked } from "./eval-spend.js";
import { scoreCandidates, type ScoreCandidate } from "../src/services/extractor.js";
import type { ClaudeModel } from "../src/services/model-settings.js";

const [model, samplePath, outPath, limitArg, maxUsdArg] = process.argv.slice(2) as [ClaudeModel, string, string, string?, string?];
if (!model || !samplePath || !outPath) throw new Error("Usage: eval-scorer.ts <model> <sample.json> <out.jsonl> [limit] [maxUsd]");

interface Batch { batchId: string; prompt: string; name: string; candidates: ScoreCandidate[] }
const done = new Set(
  fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { batchId: string }).batchId) : []
);
const batches = (JSON.parse(fs.readFileSync(samplePath, "utf8")) as Batch[])
  .slice(0, limitArg ? Number(limitArg) : undefined)
  .filter((b) => !done.has(b.batchId));
const maxUsd = maxUsdArg ? Number(maxUsdArg) : Infinity;
const startTotal = total$();

let next = 0;
async function worker() {
  while (next < batches.length) {
    if (total$() - startTotal >= maxUsd) return;
    const batch = batches[next++]!;
    const run = await tracked(`scorer:${model}:${batch.batchId}`, () =>
      scoreCandidates(batch.candidates, batch.prompt, batch.name, undefined, false, model)
    );
    const scores = run.value?.map((c) => ({ matchScore: c.matchScore, matchReason: c.matchReason })) ?? null;
    const call = run.calls.at(-1);
    const failure = run.error
      ? "error"
      : call?.stopReason === "refusal"
        ? "refusal"
        : call?.stopReason === "max_tokens"
          ? "truncated"
          : scores?.every((s) => s.matchScore === null)
            ? (call?.text.trim() ? "unparseable" : "empty")
            : scores?.some((s) => s.matchScore === null)
              ? "partial"
              : null;
    fs.appendFileSync(
      outPath,
      JSON.stringify({
        batchId: batch.batchId,
        model,
        scores,
        failure,
        error: run.error,
        usd: run.calls.reduce((s, c) => s + c.usd, 0),
        ms: run.calls.reduce((s, c) => s + c.ms, 0),
        outputTokens: run.calls.reduce((s, c) => s + c.outputTokens, 0),
        inputTokens: run.calls.reduce((s, c) => s + c.inputTokens, 0),
        stopReason: call?.stopReason ?? null,
        blockTypes: call?.blockTypes ?? [],
        ...(failure && failure !== "partial" ? { text: call?.text.slice(0, 2000) } : {}),
      }) + "\n"
    );
  }
}

await Promise.all(Array.from({ length: 6 }, worker));
console.log(`${model}: run spent $${(total$() - startTotal).toFixed(3)}, ledger total $${total$().toFixed(3)}`);
