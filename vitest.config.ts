import path from "node:path";
import { defineConfig } from "vitest/config";

// The simulation harness (docs/GOTCHAS.md "The simulated environment"): tests run the REAL
// lib code — db.ts against a throwaway local SQLite file, the Spotify client against a
// scripted global-fetch stub — so nothing touches the Zenbook store, Spotify, or Vercel.
// The only framework pieces stubbed are the two Next server-runtime shims below.
export default defineConfig({
  resolve: {
    alias: [
      // Order matters: specific module ids before the `@/` prefix.
      { find: "server-only", replacement: path.resolve(__dirname, "tests/stubs/empty.ts") },
      { find: "next/cache", replacement: path.resolve(__dirname, "tests/stubs/next-cache.ts") },
      { find: "@", replacement: path.resolve(__dirname, "src") },
    ],
  },
  test: {
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    // src/lib/store-diff.test.ts is a node:test suite (run via `npm test` alongside this).
    include: ["tests/**/*.test.ts"],
    // Each test file gets its own process (fresh module state, fresh store file) — the lib
    // modules carry deliberate module-scoped state (cooldowns, counters) that must not
    // leak between files.
    pool: "forks",
    testTimeout: 15000,
  },
});
