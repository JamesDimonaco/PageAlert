import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, SCORER_MODEL, modelSettings } from "./model-settings.js";

// Each model rejects a different way of switching reasoning off. A wrong
// field here is a 400 on every call, which the scheduler reads as "unscored"
// and alerts on everything.
describe("modelSettings", () => {
  it("keeps prod on Sonnet 5 with thinking disabled", () => {
    expect(DEFAULT_MODEL).toBe("claude-sonnet-5");
    expect(modelSettings(DEFAULT_MODEL)).toEqual({ model: "claude-sonnet-5", thinking: { type: "disabled" } });
  });

  it("sends Sonnet 5.5 between_tools alone, since it 400s on disabled", () => {
    expect(modelSettings("claude-sonnet-5-5")).toEqual({ model: "claude-sonnet-5-5", thinking: { type: "between_tools" } });
  });

  it("disables thinking on Haiku 5.5 at low effort", () => {
    expect(modelSettings("claude-haiku-5-5")).toEqual({
      model: "claude-haiku-5-5",
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
    });
  });

  it("sends Opus 5.5 no thinking field, since it cannot be disabled", () => {
    expect(modelSettings("claude-opus-5-5")).toEqual({ model: "claude-opus-5-5", output_config: { effort: "low" } });
  });
});

// Eval, 15/11/2026, 200 prod batches: Opus 5.5 at low effort caught 94% of
// real matches and broke no price limit; Sonnet 5 caught 51-66% and broke 25
// of 243. The full read and search stayed on Sonnet 5: Haiku found under half
// the items, and Sonnet 5.5 searched no better for 63% more.
describe("models per step", () => {
  it("scores on Opus 5.5 and reads pages and searches on Sonnet 5", () => {
    expect(SCORER_MODEL).toBe("claude-opus-5-5");
    expect(DEFAULT_MODEL).toBe("claude-sonnet-5");
  });
});
