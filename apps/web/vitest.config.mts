import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // convex-test runs functions in the same runtime Convex does
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["convex/**/*.test.ts"],
    // The first test in each file pays for loading every Convex module, which
    // can pass 5s on a cold machine and fail a suite that is otherwise green.
    testTimeout: 15_000,
  },
});
