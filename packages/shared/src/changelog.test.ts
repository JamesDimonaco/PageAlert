import { describe, expect, it } from "vitest";
import { CHANGELOG, latestChangelogEntry } from "./changelog";

describe("CHANGELOG", () => {
  // The popup shows whichever entry is first, so an entry added lower down would never pop up.
  it("lists entries newest first", () => {
    const dates = CHANGELOG.map((e) => e.date);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(latestChangelogEntry()).toBe(CHANGELOG[0]);
  });

  // A reused id would count as already seen, so the new entry would never pop up.
  it("gives every entry its own id", () => {
    const ids = CHANGELOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("dates every entry as a real YYYY-MM-DD day", () => {
    for (const e of CHANGELOG) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${e.date}T00:00:00Z`).toISOString().slice(0, 10)).toBe(e.date);
    }
  });
});
