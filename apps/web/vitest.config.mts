import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // convex-test runs the functions in a sandbox mirroring the Convex
    // runtime, which is not Node's.
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
    include: ["convex/**/*.test.ts"],
  },
});
