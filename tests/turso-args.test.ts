// Turso's rule for a statement's args, which every suite's client applies (tests/stubs/libsql-client.mjs).
// Each case's answer was measured on a local sqld 0.24.32 over HTTP (lane 40, Oct 22, 2026). A `file:`
// client ran every refused case it was given, binding NULL where an arg was missing, and its native
// binding panicked on a positional parameter given named args. Turso cloud refused the extra named arg
// as sqld does (lane 23, "Number of arguments mismatch"); the other cases were not measured there.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createClient, LibsqlBatchError, LibsqlError } from "@libsql/client";
import { describe, expect, it } from "vitest";
import { argsMismatch, sqlParameters } from "./stubs/libsql-client.mjs";

type Args = Record<string, unknown> | unknown[] | undefined;
const sqld: [string, string, Args, string | null][] = [
  ["exact", "SELECT :a AS v", { a: 1 }, null],
  ["extra", "SELECT :a AS v", { a: 1, b: 2 }, "too many parameters, expected 1 found 2"],
  ["missing", "SELECT :a AS v, :b AS w", { a: 1 }, "value for parameter :b not found"],
  ["wrong name, same count", "SELECT :a AS v, :b AS w", { a: 1, c: 2 }, "value for parameter :b not found"],
  ["repeated name", "SELECT :a AS v, :a AS w", { a: 1 }, null],
  ["prefixed key", "SELECT :a AS v", { ":a": 1 }, null],
  ["prefixed and bare key", "SELECT :a AS v", { a: 1, ":a": 1 }, "too many parameters, expected 1 found 2"],
  ["@ parameter", "SELECT @a AS v", { a: 1 }, null],
  ["$ parameter", "SELECT $a AS v", { a: 1 }, null],
  ["two prefixes, one key", "SELECT :a AS v, @a AS w", { a: 1 }, null],
  ["no parameters, empty args", "SELECT 1 AS v", {}, null],
  ["no parameters, an arg", "SELECT 1 AS v", { a: 1 }, "too many parameters, expected 0 found 1"],
  ["no parameters, no args", "SELECT 1 AS v", undefined, null],
  ["a parameter, no args", "SELECT :a AS v", undefined, "value for parameter :a not found"],
  ["null value, extra", "SELECT :a AS v", { a: 1, b: null }, "too many parameters, expected 1 found 2"],
  ["positional", "SELECT ? AS v", [1], null],
  ["positional, extra", "SELECT ? AS v", [1, 2], "too many parameters, expected 1 found 2"],
  ["positional, missing", "SELECT ? AS v, ? AS w", [1], "value for parameter 2 not found"],
  ["positional, none", "SELECT ? AS v", [], "value for parameter 1 not found"],
  ["?N repeated", "SELECT ?1 AS v, ?1 AS w", [1], null],
  ["?N past a gap", "SELECT ?2 AS v", [1, 2], null],
  ["?N past a gap, short", "SELECT ?2 AS v", [1], "value for parameter ?2 not found"],
  ["? after ?N", "SELECT ?2 AS v, ? AS w", [1, 2, 3], null],
  [":a and ?1", "SELECT :a AS v, ?1 AS w", { a: 1 }, null],
  ["named param, positional args", "SELECT :a AS v", [1], "value for parameter :a not found"],
  ["positional param, named args", "SELECT ? AS v", { a: 1 }, "value for parameter 1 not found"],
  ["?N param, named args", "SELECT ?1 AS v", { a: 1 }, "value for parameter ?1 not found"],
  ["in a string", "SELECT ':a' AS v", {}, null],
  ["in a string, an arg", "SELECT ':a' AS v", { a: 1 }, "too many parameters, expected 0 found 1"],
  ["doubled quote", "SELECT 'it''s :a' AS v", {}, null],
  ["line comment", "SELECT :a AS v -- :b\n", { a: 1 }, null],
  ["block comment", "SELECT :a AS v /* :b */", { a: 1 }, null],
  ["quoted name", 'SELECT :a AS "c:b"', { a: 1 }, null],
  ["bracketed name", "SELECT 1 AS [x:a]", {}, null],
  ["$ inside a name", "SELECT 1 AS a$b", {}, null],
  [
    "upsert",
    "INSERT INTO t (k, v) VALUES (:k, :v) ON CONFLICT(k) DO UPDATE SET v = excluded.v WHERE :v > t.v",
    { k: "x", v: 1 },
    null,
  ],
];

describe("Turso's args rule, as sqld answers it", () => {
  it.each(sqld)("%s", (_name, sql, args, want) => {
    expect(argsMismatch(sql, args)).toBe(want);
  });

  it("numbers parameters as SQLite does", () => {
    expect(sqlParameters("SELECT ?2, :a, ?, :a, @a, $a")).toEqual([null, "?2", ":a", null, "@a", "$a"]);
  });
});

describe("every client the suites open applies it", () => {
  const c = createClient({ url: "file::memory:", intMode: "number" });
  const extra = { sql: "SELECT :a AS v", args: { a: 1, b: 2 } };

  it("execute refuses, and answers an exact call", async () => {
    await expect(c.execute(extra)).rejects.toThrow(LibsqlError);
    await expect(c.execute(extra)).rejects.toThrow(
      "ARGS_INVALID: Arguments do not match SQL parameters: too many parameters, expected 1 found 2",
    );
    await expect(c.execute("SELECT :a AS v", { a: 1, b: 2 })).rejects.toThrow("ARGS_INVALID");
    expect((await c.execute({ sql: "SELECT :a AS v", args: { a: 7 } })).rows[0].v).toBe(7);
  });

  it("a batch with one bad statement runs none of it", async () => {
    await c.execute("CREATE TABLE IF NOT EXISTS t (k TEXT PRIMARY KEY)");
    const err = await c
      .batch([{ sql: "INSERT INTO t (k) VALUES (:k)", args: { k: "x" } }, extra], "write")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LibsqlBatchError);
    expect((err as LibsqlBatchError).statementIndex).toBe(1);
    expect((await c.execute("SELECT count(*) AS n FROM t")).rows[0].n).toBe(0);
    await expect(c.batch([["SELECT :a", { a: 1, b: 2 }]], "read")).rejects.toThrow("ARGS_INVALID");
    await expect(c.migrate([extra])).rejects.toThrow("ARGS_INVALID");
  });

  it("a transaction's statements too", async () => {
    const tx = await c.transaction("write");
    try {
      await expect(tx.execute(extra)).rejects.toThrow("ARGS_INVALID");
      await expect(tx.batch([extra])).rejects.toThrow("ARGS_INVALID");
    } finally {
      tx.close();
    }
  });

  it("so does a script a suite spawns", () => {
    const script = [
      'import { createClient } from "@libsql/client";',
      'const c = createClient({ url: "file::memory:" });',
      'try { await c.execute({ sql: "SELECT :a", args: { a: 1, b: 2 } }); console.log("accepted"); }',
      "catch (e) { console.log(e.code); }",
    ].join("\n");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
    });
    expect(r.stderr).toBe("");
    expect(r.stdout.trim()).toBe("ARGS_INVALID");
  });
});
