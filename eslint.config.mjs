import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // We render many tiny Spotify CDN thumbnails from varied hosts; plain <img>
      // avoids next/image remote-host config for little benefit. See playlist-thumb.tsx.
      "@next/next/no-img-element": "off",
      // `_name` = deliberately unused. The cached reads in db.ts take the write marker as an
      // argument purely to put it in the cache KEY, so the parameter is real and load-bearing
      // while the binding is never read.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
