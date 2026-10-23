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
      // The real client, refusing a statement whose args are not its parameters, as Turso does
      // and a `file:` database does not (tests/stubs/libsql-client.mjs).
      { find: /^@libsql\/client$/, replacement: path.resolve(__dirname, "tests/stubs/libsql-client.mjs") },
      // next-auth imports the extensionless "next/server", which Node's ESM resolver refuses;
      // with next-auth inlined below, this lets the REAL Auth.js run in tests (the authz suite).
      { find: /^next\/server$/, replacement: "next/server.js" },
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
    server: { deps: { inline: ["next-auth", "@auth/core"] } },
    testTimeout: 15000,
  },
});
