import type Anthropic from "@anthropic-ai/sdk";

export type ClaudeModel = "claude-sonnet-5" | "claude-sonnet-5-5" | "claude-haiku-5-5" | "claude-opus-5-5";

/** The full page read and product search. */
export const DEFAULT_MODEL: ClaudeModel = "claude-sonnet-5";

/**
 * Judging entries against the prompt, and reading a product's stock and price.
 * Opus 5.5 was the only model in the 15/11/2026 eval that broke no price limit.
 */
export const SCORER_MODEL: ClaudeModel = "claude-opus-5-5";

/**
 * Request fields that run a model with as little reasoning as it allows.
 *
 * Every AI step here is a one-shot JSON task whose reasoning tokens would come
 * out of max_tokens. Each model turns reasoning off a different way, and the
 * wrong one is a 400.
 */
export function modelSettings(
  model: ClaudeModel
): Pick<Anthropic.MessageCreateParamsNonStreaming, "model" | "thinking" | "output_config"> {
  switch (model) {
    case "claude-sonnet-5":
      return { model, thinking: { type: "disabled" } };
    case "claude-sonnet-5-5":
      // Rejects "disabled". between_tools takes no other thinking field and
      // is valid only at effort high or below, which is its default.
      return { model, thinking: { type: "between_tools" } };
    case "claude-haiku-5-5":
      return { model, thinking: { type: "disabled" }, output_config: { effort: "low" } };
    case "claude-opus-5-5":
      // Thinking cannot be disabled; low effort is the only lever.
      return { model, output_config: { effort: "low" } };
  }
}
