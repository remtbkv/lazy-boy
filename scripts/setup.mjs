// One-time local setup: create .env.local from .env.example and generate AUTH_SECRET, so a
// new user only has to paste their Spotify Client ID + Secret. Safe to re-run — it never
// overwrites an existing .env.local. Run with `npm run setup`.
import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const ENV = ".env.local";

if (existsSync(ENV)) {
  console.log(`${ENV} already exists — leaving it as-is.`);
} else {
  copyFileSync(".env.example", ENV);
  const secret = randomBytes(32).toString("base64");
  const filled = readFileSync(ENV, "utf8").replace(/^AUTH_SECRET=.*$/m, `AUTH_SECRET=${secret}`);
  writeFileSync(ENV, filled);
  console.log(`Created ${ENV} with a generated AUTH_SECRET.`);
}

console.log(
  "\nNext: paste your Spotify Client ID + Secret into .env.local (that's all you need for\nlocal use), then run `npm run dev` and open http://127.0.0.1:3000.",
);
