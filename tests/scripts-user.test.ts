// T10 (PLAN.md §6.4): every script that reads or writes a user's database requires --user, checks
// it before it opens anything, and refuses a database that names another owner; the backstop
// replay runs for the admin alone. The scripts run as real child processes against throwaway
// files; a refusal must leave no file behind (it never opened one).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { scriptUser, ScriptUserError, withoutUser } from "../scripts/script-user.mjs";

const root = path.resolve(__dirname, "..");
const OWNER = "ownerownerow";
const OTHER = "bbbbbbbbbbbb";

// Each store script, with the arguments it needs to get as far as opening its database.
const SCRIPTS: Record<string, string[]> = {
  "backfill-from-backstop.mjs": ["/nonexistent/backstop.jsonl"],
  "import-extended-history.mjs": ["/nonexistent/export"],
  "backfill-scan.mjs": [],
  "bench-reads.mjs": ["cold"],
  "migrate-skip-rule.mjs": [],
  "verify-derived.mjs": [],
};

function run(script: string, args: string[], dbUrl: string) {
  return spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, OWNER_UID: OWNER, TURSO_DATABASE_URL: dbUrl, TURSO_AUTH_TOKEN: "" },
  });
}

function freshPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), "lazyboy-t10-")), "never.db");
}

describe("T10: the scripts' --user", () => {
  for (const [script, args] of Object.entries(SCRIPTS)) {
    const dbArgs = (file: string) =>
      script === "backfill-from-backstop.mjs" || script === "import-extended-history.mjs" ? ["--db", `file:${file}`] : [];

    it(`${script} exits 2 without --user, before opening a database`, () => {
      const file = freshPath();
      const r = run(script, [...args, ...dbArgs(file)], `file:${file}`);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(/--user <uid> is required/);
      expect(existsSync(file)).toBe(false);
    });

    it(`${script} exits 2 for a user it does not know`, () => {
      const file = freshPath();
      const r = run(script, [...args, "--user", OTHER, ...dbArgs(file)], `file:${file}`);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toMatch(new RegExp(`no user ${OTHER}`));
      expect(existsSync(file)).toBe(false);
    });
  }

  it("a database that names another owner is refused after --user passes", async () => {
    const file = freshPath();
    const c = createClient({ url: `file:${file}` });
    await c.executeMultiple(
      `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('owner_uid', '${OTHER}');`,
    );
    c.close();
    const r = run("verify-derived.mjs", ["--user", OWNER], `file:${file}`);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(new RegExp(`belongs to ${OTHER}, not ${OWNER}`));
  });
});

describe("scriptUser", () => {
  const env = { OWNER_UID: OWNER };

  it("returns the owner, the admin, at Rem's database", () => {
    expect(scriptUser(["x", "--user", OWNER], env)).toEqual({ uid: OWNER, admin: true, dbName: "lazyboy" });
    expect(scriptUser(["--user", OWNER], env, { adminOnly: true }).admin).toBe(true);
  });

  it("refuses a missing, malformed or unknown --user, and any user when OWNER_UID is unset", () => {
    expect(() => scriptUser(["x"], env)).toThrow(ScriptUserError);
    expect(() => scriptUser(["--user"], env)).toThrow(/required/);
    expect(() => scriptUser(["--user", "Rem"], env)).toThrow(/required/);
    expect(() => scriptUser(["--user", OTHER], env)).toThrow(/no user/);
    expect(() => scriptUser(["--user", OWNER], {})).toThrow(/OWNER_UID/);
  });

  it("withoutUser drops the flag and its value, leaving the rest in order", () => {
    expect(withoutUser(["a", "--user", OWNER, "--db", "f"])).toEqual(["a", "--db", "f"]);
    expect(withoutUser(["a"])).toEqual(["a"]);
  });
});
