// Renders docs/multi-user/AUTHZ.md from the registry and from the code: the entry-point census
// comes from globbing src/app, each gate's line from its anchor, each entry's store and Spotify
// calls from its source, the red-team list from authz-redteam.test.ts. authz-map.test.ts fails
// when the committed doc differs; `AUTHZ_WRITE=1 npx vitest run tests/isolation/authz-map.test.ts`
// rewrites it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { PRINCIPAL_LABEL, PRINCIPALS, type Principal } from "./authz-harness";
import { ENTRIES, FINDINGS, type Cell, type Entry, type Phase } from "./authz-registry";

export const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** Every entry point the code has: [id, file]. Route handlers per exported method, pages and
 *  layouts per file, server actions per exported async function of a "use server" module. */
export function censusFromCode(): { id: string; file: string }[] {
  const out: { id: string; file: string }[] = [];
  for (const abs of walk(path.join(ROOT, "src/app"))) {
    const rel = path.relative(ROOT, abs);
    const base = path.basename(rel);
    const src = readFileSync(abs, "utf8");
    const urlDir = path
      .dirname(rel)
      .replace(/^src\/app/, "")
      .split("/")
      .filter((s) => s && !/^\(.*\)$/.test(s))
      .join("/");
    if (base === "route.ts") {
      for (const m of src.matchAll(/^export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/gm)) {
        out.push({ id: `${m[1]} /${urlDir}`, file: rel });
      }
    } else if (base === "page.tsx") {
      out.push({ id: `page /${urlDir}`, file: rel });
    } else if (base === "layout.tsx") {
      const group = path.dirname(rel).match(/\(([^)]+)\)$/)?.[1];
      out.push({ id: `layout (${group ?? "root"})`, file: rel });
    } else if (/\.(ts|tsx)$/.test(base) && /^\s*["']use server["']/.test(src)) {
      for (const m of src.matchAll(/^export async function (\w+)/gm)) out.push({ id: `action ${m[1]}`, file: rel });
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** The registry entry that accounts for a code entry point (the Auth.js catch-all maps to its
 *  sub-paths by method). */
export function registryFor(code: { id: string; file: string }): Entry[] {
  if (code.file.includes("[...nextauth]")) {
    const method = code.id.split(" ")[0];
    return ENTRIES.filter((e) => e.file === code.file && e.id.startsWith(`${method} /api/auth/`));
  }
  return ENTRIES.filter((e) => e.id === code.id);
}

export function gateLine(e: Entry): number | null {
  if (!e.gate) return null;
  const file = e.gateFile ?? e.file;
  const i = read(file).split("\n").findIndex((l) => l.includes(e.gate!));
  return i === -1 ? null : i + 1;
}

/** The source an entry runs: a route or page file whole; an action's own body plus the bodies of
 *  the local helpers it calls. */
function sourceOf(e: Entry): string {
  const src = read(e.file);
  if (e.kind !== "action") return src;
  const name = e.id.replace(/^action /, "");
  const body = (fn: string) => {
    const start = src.search(new RegExp(`^(?:export )?(?:async )?function ${fn}\\b`, "m"));
    if (start === -1) return "";
    const rest = src.slice(start + 1);
    const end = rest.search(/^(?:export )?(?:async )?function |^export /m);
    return src.slice(start, end === -1 ? undefined : start + 1 + end);
  };
  const own = body(name);
  const helpers = [...own.matchAll(/\b([a-z]\w+)\(/g)]
    .map((m) => m[1])
    .filter((h) => h !== name && new RegExp(`^(?:async )?function ${h}\\b`, "m").test(src));
  return [own, ...new Set(helpers)].map((h, i) => (i === 0 ? h : body(h))).join("\n");
}

const WRITE = /^(set|record|store|upsert|delete|remove|clear|rebuild|recompute|prune|ledger|acquire|release|log)/;

export function callsOf(e: Entry): { store: string[]; spotify: string[]; via: string[] } {
  if (e.kind === "auth") return { store: [], spotify: [], via: ["Auth.js"] };
  const file = read(e.file);
  const src = sourceOf(e);
  const imported = (mod: RegExp) =>
    [...file.matchAll(/import\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)]
      .filter((m) => mod.test(m[2]))
      .flatMap((m) => m[1].split(",").map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]))
      .filter((x) => x && /^[a-z]/.test(x));
  const used = (names: string[]) => [...new Set(names.filter((n) => new RegExp(`\\b${n}\\(`).test(src)))];
  const store = used(imported(/^@\/lib\/db$/)).map((n) => (WRITE.test(n) ? `${n} (w)` : n));
  const spotify = [
    ...new Set([
      ...[...src.matchAll(/\bsp\.(\w+)\(/g)].map((m) => m[1]),
      ...[...src.matchAll(/spotifyClient\([^;]*?\)\s*\.\s*(\w+)\(/g)].map((m) => m[1]),
    ]),
  ];
  const via = used(imported(/^@\/lib\/(?!db$)/)).filter((n) => !/^(auth|cn)$/.test(n));
  return { store, spotify, via };
}

const SYMBOL: Record<Cell["target"], string> = { allow: "A", deny: "D", isolated: "I" };
const TODAY: Record<string, string> = { allow: "A", deny: "D", "allow-own": "a" };

function cellText(c: Cell): string {
  return c.today ? `${SYMBOL[c.target]} ←${TODAY[c.today]} ${c.phase}` : SYMBOL[c.target];
}

function redteamTitles(): { title: string; pinned: string | null }[] {
  const src = read("tests/isolation/authz-redteam.test.ts");
  return [...src.matchAll(/^\s*it\("((?:[^"\\]|\\.)*)"/gm)].map((m) => {
    const title = m[1].replace(/\\"/g, '"');
    return { title, pinned: title.match(/^pinned (\w+):/)?.[1] ?? null };
  });
}

export function renderAuthz(): string {
  const L: string[] = [];
  const cells = ENTRIES.flatMap((e) => PRINCIPALS.map((p) => ({ e, p, c: e.cells[p] })));
  const pinned = cells.filter((x) => x.c.today);
  const byPhase = new Map<Phase, typeof pinned>();
  for (const x of pinned) byPhase.set(x.c.phase!, [...(byPhase.get(x.c.phase!) ?? []), x]);
  const rt = redteamTitles();
  const count = (t: Cell["target"]) => cells.filter((x) => x.c.target === t).length;

  L.push("# Who may call what: the authorization map");
  L.push("");
  L.push(
    "Generated from `tests/isolation/authz-registry.ts` and the code by `tests/isolation/authz-doc.ts`; do not edit by hand. " +
      "`npm test` fails when this file is stale; `AUTHZ_WRITE=1 npx vitest run tests/isolation/authz-map.test.ts` rewrites it. " +
      "Every cell below is a test (`tests/isolation/authz-{route,auth,action,page}.test.ts`) that runs the entry point through the real Auth.js " +
      "(a real cookie, src/lib/auth.ts's own callbacks) against a throwaway store seeded with Rem's rows and the scripted Spotify.",
  );
  L.push("");
  L.push(
    `${ENTRIES.length} entry points × ${PRINCIPALS.length} principals = ${cells.length} cells: ${count("allow")} allow, ${count("deny")} deny, ` +
      `${count("isolated")} isolated. ${pinned.length} cells are not at their target in today's single-user code; each is pinned to what it does ` +
      `today and names the phase that moves it. ${Object.keys(FINDINGS).length} findings (cells with no explicit rule), ` +
      `${rt.length} red-team checks (${rt.filter((r) => r.pinned).length} pinned).`,
  );
  L.push("");
  L.push("`AUTHZ_TARGET=1 npx vitest run tests/isolation/authz-` runs every pinned cell and check against its target instead: what fails is what the phases still owe.");
  L.push("");
  L.push("## 1. Principals, verdicts, phases");
  L.push("");
  for (const p of PRINCIPALS) L.push(`- \`${p}\`: ${PRINCIPAL_LABEL[p]}`);
  L.push("");
  L.push(
    "Verdicts: **A** allow (Rem's own entry points: it must reach Rem's data, rows or Spotify grant; public ones: not refused). " +
      "**D** deny (refused, and nothing of Rem's read into the answer, written, or called on Spotify). " +
      "**I** isolated (a friend: never Rem's data, rows or grant; refused until Phase 4a, their own data after). " +
      "`D ←A P1` = target D, today A (it reaches Rem's data), Phase 1 moves it; `a` = today it answers without touching anything of Rem's.",
  );
  L.push("");
  L.push(
    "Phases: P1 Phase 1's turn (lane 12: requireUser and the uid's identity check, forUser, userCache, uid in ETags and bodies, " +
      "/usage admin-only, /api/metrics' uid, auth_time); P2 Phase 2's turn (lane 15: the identity read's status and session_epoch, per-user tokens); " +
      "P3 Phase 3's turn (lane 17: the per-user tick, daily chores on daily_at); P4a Phase 4a's turn (lane 19: Log out bumps session_epoch, " +
      "the invite claim, the bounds); L07 the interim pinger (lane 07: CRON_SECRET_EXT).",
  );
  L.push("");
  L.push("## 2. The matrix");
  L.push("");
  L.push(`| entry point | ${PRINCIPALS.join(" | ")} |`);
  L.push(`|---|${PRINCIPALS.map(() => "---").join("|")}|`);
  for (const e of ENTRIES) L.push(`| ${e.id} | ${PRINCIPALS.map((p) => cellText(e.cells[p])).join(" | ")} |`);
  L.push("");
  L.push("## 3. Each entry point");
  L.push("");
  for (const e of ENTRIES) {
    const line = gateLine(e);
    const { store, spotify, via } = callsOf(e);
    L.push(`### ${e.id}`);
    L.push("");
    L.push(`- File: \`${e.file}\`. Gate today: ${e.gate ? `\`${e.gateFile ?? e.file}:${line}\`` : "none (public)"}.`);
    L.push(`- Does, when allowed: ${e.does}.`);
    const calls = [
      store.length ? `store ${store.map((s) => `\`${s}\``).join(", ")}` : "",
      spotify.length ? `Spotify ${spotify.map((s) => `\`${s}\``).join(", ")}` : "",
      via.length ? `via ${via.map((s) => `\`${s}\``).join(", ")}` : "",
    ].filter(Boolean);
    if (calls.length) L.push(`- Calls (from the source): ${calls.join("; ")}.`);
    const groups = new Map<string, Principal[]>();
    for (const p of PRINCIPALS) {
      const c = e.cells[p];
      const key = `${cellText(c)} — ${c.rule}${c.finding ? ` [${c.finding}]` : ""}`;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    for (const [key, ps] of groups) L.push(`- ${ps.map((p) => `\`${p}\``).join(", ")}: ${key}`);
    L.push("");
  }
  L.push("## 4. Findings: cells the code has no explicit rule for");
  L.push("");
  for (const [id, f] of Object.entries(FINDINGS)) {
    const hit = cells.filter((x) => x.c.finding === id);
    const where = hit.length
      ? `${hit.length} cells: ${[...new Set(hit.map((x) => x.e.id))].join("; ")}`
      : "pinned by the red-team checks below";
    L.push(`- **${id}. ${f.title}.** ${f.detail} Owner: ${f.owner}. (${where})`);
  }
  L.push("");
  L.push("## 5. Red team (`tests/isolation/authz-redteam.test.ts`)");
  L.push("");
  L.push(
    "Every friend cell in the matrix already passes Rem's own identifiers (his playlist id `rem-pl-1`, his task id, his history day), so " +
      "another user's ids in every call are covered there. These checks take what the matrix does not reach:",
  );
  L.push("");
  for (const r of rt) L.push(`- ${r.pinned ? `[${r.pinned}] ` : "[holds] "}${r.title.replace(/^pinned \w+: /, "")}`);
  L.push("");
  L.push("## 6. What waits on which phase");
  L.push("");
  for (const phase of ["P1", "P2", "P3", "P4a", "L07"] as Phase[]) {
    const xs = byPhase.get(phase) ?? [];
    const rts = rt.filter((r) => r.pinned === phase);
    if (!xs.length && !rts.length) continue;
    const byEntry = new Map<string, Principal[]>();
    for (const x of xs) byEntry.set(x.e.id, [...(byEntry.get(x.e.id) ?? []), x.p]);
    L.push(`- **${phase}**: ${xs.length} cells and ${rts.length} red-team checks.`);
    for (const [id, ps] of byEntry) L.push(`  - ${id}: ${ps.join(", ")}`);
    for (const r of rts) L.push(`  - red team: ${r.title.replace(/^pinned \w+: /, "")}`);
  }
  L.push("");
  return L.join("\n");
}
