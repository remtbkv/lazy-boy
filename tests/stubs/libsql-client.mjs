// @libsql/client for the suites, with Turso's rule for a statement's args. vitest.config.ts aliases
// the package here, and tests/setup.ts preloads turso-args-preload.mjs so the scripts a suite spawns
// get it too. A `file:` database binds the args it is given, ignores the rest and leaves a parameter
// with no arg NULL. sqld and Turso refuse the statement (ARGS_INVALID) when it gets more args than it
// has parameters or a parameter has no arg. On Oct 22 Phase 3's claim batch threw on every production
// tick for that, on named args its statements did not use, with 2,200 tests green on `file:` (lane 23).
// tests/turso-args.test.ts holds the cases, each measured on sqld 0.24.32.
import * as real from "@libsql/client/node";

export * from "@libsql/client/node";

const idChar = (c) => c !== undefined && /[A-Za-z0-9_$\u0080-\uffff]/.test(c);

/** A statement's parameters as SQLite numbers them: entry i is parameter i + 1's name
 *  (sqlite3_bind_parameter_name), null for a bare `?`. `?` takes the next number, `?N` is number N,
 *  and `:x`, `@x`, `$x` take the next number where the name first appears. Strings, quoted names and
 *  comments hold none. */
export function sqlParameters(sql) {
  const names = [];
  const seen = new Map();
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      // A doubled quote is the quote itself, so skipping to each next quote in turn is the same.
      const end = sql.indexOf(c, i + 1);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === "[") {
      const end = sql.indexOf("]", i + 1);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (c === "?") {
      let j = i + 1;
      while (/[0-9]/.test(sql[j] ?? "")) j++;
      if (j === i + 1) names.push(null);
      else {
        const n = Number(sql.slice(i + 1, j));
        while (names.length < n) names.push(null);
        names[n - 1] ??= `?${n}`;
      }
      i = j;
    } else if ((c === ":" || c === "@" || c === "$") && idChar(sql[i + 1])) {
      let j = i + 1;
      while (idChar(sql[j])) j++;
      const name = sql.slice(i, j);
      if (!seen.has(name)) {
        names.push(name);
        seen.set(name, names.length);
      }
      i = j;
    } else if (idChar(c)) {
      // A name or a number is one token, so a `$` inside it starts no parameter.
      while (idChar(sql[i])) i++;
    } else i++;
  }
  return names;
}

/** Why sqld refuses these args for this SQL (its Params::bind, word for word), or null. A key may
 *  carry the parameter's prefix or not. */
export function argsMismatch(sql, args) {
  const params = sqlParameters(sql);
  const named = args != null && !Array.isArray(args);
  const list = named ? [] : (args ?? []);
  const given = named ? Object.keys(args).length : list.length;
  if (given > params.length) return `too many parameters, expected ${params.length} found ${given}`;
  for (let i = 0; i < params.length; i++) {
    const name = params[i];
    const found =
      name === null
        ? !named && i < list.length
        : name.startsWith("?")
          ? !named && Number(name.slice(1)) <= list.length
          : named && (Object.hasOwn(args, name) || Object.hasOwn(args, name.slice(1)));
    if (!found) return `value for parameter ${name ?? i + 1} not found`;
  }
  return null;
}

function parts(stmt, args) {
  if (typeof stmt === "string") return [stmt, args];
  if (Array.isArray(stmt)) return [stmt[0], stmt[1]];
  return [stmt.sql, stmt.args];
}

function refusal(stmt, args) {
  const [sql, a] = parts(stmt, args);
  const why = argsMismatch(sql, a);
  return why === null ? null : `Arguments do not match SQL parameters: ${why}`;
}

function batchRefusal(stmts) {
  for (let i = 0; i < stmts.length; i++) {
    const why = refusal(stmts[i]);
    // sqld's batch error, as the http client reports it.
    if (why !== null) return new real.LibsqlBatchError(`ARGS_INVALID: ${why}`, i, "ARGS_INVALID");
  }
  return null;
}

/** The client (or transaction) with every execute, batch and migrate checked first, as own
 *  properties so a test that wraps them in turn (open.test.ts, orphan-scope.test.ts) wraps these. A
 *  refused call runs nothing, as on sqld: a batch is one transaction there. A call that passes
 *  reaches the real method unchanged, in the same tick. */
function guard(c) {
  const execute = c.execute.bind(c);
  c.execute = (stmt, args) => {
    const why = refusal(stmt, args);
    return why === null ? execute(stmt, args) : Promise.reject(new real.LibsqlError(why, "ARGS_INVALID"));
  };
  for (const name of ["batch", "migrate"]) {
    if (typeof c[name] !== "function") continue;
    const run = c[name].bind(c);
    c[name] = (stmts, ...rest) => {
      const e = batchRefusal(stmts);
      return e === null ? run(stmts, ...rest) : Promise.reject(e);
    };
  }
  if (typeof c.transaction === "function") {
    const transaction = c.transaction.bind(c);
    c.transaction = (...a) => transaction(...a).then(guard);
  }
  return c;
}

export function createClient(config) {
  return guard(real.createClient(config));
}
