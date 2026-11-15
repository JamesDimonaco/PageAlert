/**
 * Spend ledger for the model-eval scripts.
 *
 * Patches the SDK's messages.create so every call, whichever service made it,
 * is priced from its own `usage` and appended to a JSONL ledger. The ledger
 * is shared across scripts, and a call that would start with the total at or
 * past SPEND_CAP_USD throws instead of running. The total moves when a call
 * returns, so calls already in flight can carry it past the cap. Each process
 * reads the ledger once at start, so run one script at a time.
 *
 * Needs a plain client: run with POSTHOG_KEY unset, or getClient() returns
 * the PostHog wrapper, which bundles its own SDK copy this patch misses.
 */
import Anthropic from "@anthropic-ai/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";

if (process.env.POSTHOG_KEY) throw new Error("Unset POSTHOG_KEY: the eval must use the plain SDK client");

const LEDGER = process.env.EVAL_LEDGER;
if (!LEDGER) throw new Error("Set EVAL_LEDGER to a JSONL file outside the repo");
const CAP = Number(process.env.SPEND_CAP_USD ?? "15");

/** USD per million tokens, input then output. */
const PRICES: Record<string, [number, number]> = {
  "claude-sonnet-5": [2, 10],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-opus-5-5": [4, 20],
};
const WEB_SEARCH_USD = 0.01;

export interface CallRecord {
  tag: string;
  model: string;
  ms: number;
  usd: number;
  inputTokens: number;
  outputTokens: number;
  searches: number;
  stopReason: string | null;
  blockTypes: string[];
  text: string;
  error?: string;
}

export function costOf(model: string, usage: Anthropic.Usage): number {
  const price = PRICES[model];
  if (!price) throw new Error(`No price for ${model}`);
  const input = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) * 1.25 + (usage.cache_read_input_tokens ?? 0) * 0.1;
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return (input * price[0] + usage.output_tokens * price[1]) / 1e6 + searches * WEB_SEARCH_USD;
}

export function spentSoFar(): number {
  if (!fs.existsSync(LEDGER!)) return 0;
  return fs
    .readFileSync(LEDGER!, "utf8")
    .split("\n")
    .filter(Boolean)
    .reduce((sum, line) => sum + (JSON.parse(line) as CallRecord).usd, 0);
}

let total = spentSoFar();
const context = new AsyncLocalStorage<{ tag: string; calls: CallRecord[] }>();

/** Run fn with every API call it makes recorded under tag. */
export async function tracked<T>(tag: string, fn: () => Promise<T>): Promise<{ value?: T; error?: string; calls: CallRecord[] }> {
  const calls: CallRecord[] = [];
  try {
    const value = await context.run({ tag, calls }, fn);
    return { value, calls };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), calls };
  }
}

export const total$ = () => total;

const proto = Object.getPrototypeOf(new Anthropic({ apiKey: "unused" }).messages) as {
  create: (body: Anthropic.MessageCreateParamsNonStreaming, options?: unknown) => Promise<Anthropic.Message>;
};
const original = proto.create;
proto.create = async function (this: unknown, body, options) {
  if (total >= CAP) throw new Error(`Spend cap reached: $${total.toFixed(2)} of $${CAP}`);
  const store = context.getStore();
  const start = Date.now();
  const record = (message: Anthropic.Message | null, error?: string) => {
    const usd = message ? costOf(body.model, message.usage) : 0;
    total += usd;
    const entry: CallRecord = {
      tag: store?.tag ?? "untagged",
      model: body.model,
      ms: Date.now() - start,
      usd,
      inputTokens: message?.usage.input_tokens ?? 0,
      outputTokens: message?.usage.output_tokens ?? 0,
      searches: message?.usage.server_tool_use?.web_search_requests ?? 0,
      stopReason: message?.stop_reason ?? null,
      blockTypes: message?.content.map((b) => b.type) ?? [],
      text: message?.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("") ?? "",
      ...(error ? { error } : {}),
    };
    store?.calls.push(entry);
    fs.appendFileSync(LEDGER!, JSON.stringify({ ...entry, text: entry.text.slice(0, 4000) }) + "\n");
  };
  try {
    const message = await original.call(this, body, options);
    record(message);
    return message;
  } catch (error) {
    record(null, error instanceof Error ? error.message : String(error));
    throw error;
  }
};
