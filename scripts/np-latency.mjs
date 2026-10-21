// Read-only. How fast a song change reaches a visible Lazy Boy tab, and whether Home's verdict
// on a finished song matches the store's (docs/NOW_PLAYING_2S.md §4.1-§4.4, lanes L1 and L2).
//
//   node --env-file=.env.local scripts/np-latency.mjs --user <OWNER_UID> [--since <ISO>]
//
// From the telemetry store (TELEMETRY_DATABASE_URL; client_metrics, this user's rows only):
//   np-change rows: n, p50, p95 and max of the bound by path and kind (nearest rank, as db.ts),
//     and how many per-tab sequence numbers are missing (a beacon batch lost on its way).
//   handoff rows: Home's verdict on each finished song, joined to the store's plays
//     (TURSO_DATABASE_URL) by track id within ±15 s of the instant Home saw it stop. A play whose
//     predecessor in the store is not the song Home saw before it is excluded and listed (REVIEW
//     M7: an unlisted predecessor lengthens the store's run). Plays the store never listed are
//     listed apart (decision D3's input).
import { createClient } from "@libsql/client";
import { checkScriptDb, scriptUserOrExit } from "./script-user.mjs";

/** Nearest-rank percentile (p a fraction), as db.ts's. */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i];
}

/** `a=1|b=2|label` → { a: "1", b: "2" } (fields without `=` are skipped, metrics-client's
 *  `pv:<view>` tag among them). */
export function parseMeta(meta) {
  const out = {};
  for (const part of String(meta ?? "").split("|")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

/** np-change rows → [{ path, kind, n, p50, p95, max }], sorted by path then kind. */
export function summarize(rows) {
  const groups = new Map();
  for (const r of rows) {
    const m = parseMeta(r.meta);
    const key = `${m.path ?? "?"}\n${m.kind ?? "?"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(Number(r.value));
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => {
      const [path, kind] = key.split("\n");
      return { path, kind, n: v.length, p50: percentile(v, 0.5), p95: percentile(v, 0.95), max: Math.max(...v) };
    });
}

/** Missing sequence numbers per tab session. Each page load counts from 1, and a reload keeps
 *  the tab's session id, so a session's rows in time order split into runs wherever the count
 *  goes back. */
export function seqGaps(rows) {
  const bySession = new Map();
  for (const r of [...rows].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))) {
    const seq = Number(parseMeta(r.meta).seq);
    if (!Number.isFinite(seq)) continue;
    if (!bySession.has(r.session)) bySession.set(r.session, []);
    bySession.get(r.session).push(seq);
  }
  let missing = 0;
  for (const seqs of bySession.values()) {
    let run = new Set();
    let last = 0;
    const close = () => {
      if (run.size) missing += Math.max(...run) - run.size;
    };
    for (const seq of seqs) {
      if (seq <= last) {
        close();
        run = new Set();
      }
      run.add(seq);
      last = seq;
    }
    close();
  }
  return { sessions: bySession.size, missing };
}

const MATCH_MS = 15_000;

/** Home's verdicts (handoff rows) against the store's plays ({ played_at, track_id, skipped }). */
export function joinVerdicts(handoffs, plays) {
  const ordered = [...plays].sort((a, b) => (a.played_at < b.played_at ? -1 : 1));
  const out = { judged: 0, agree: 0, disagree: [], pending: { listen: 0, skip: 0 }, excluded: [], unlisted: [] };
  for (const h of handoffs) {
    // The verdict is the first field that is neither a key=value nor the page-view tag.
    const home = String(h.meta ?? "").split("|").find((f) => !f.includes("=") && !f.startsWith("pv:"));
    if (home !== "commit" && home !== "skip" && home !== "pending") continue;
    const m = parseMeta(h.meta);
    const at = Number(m.at);
    if (!m.id || !Number.isFinite(at)) continue;
    out.judged++;
    let best = -1;
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i].track_id !== m.id) continue;
      const d = Math.abs(Date.parse(ordered[i].played_at) - at);
      if (d <= MATCH_MS && (best < 0 || d < Math.abs(Date.parse(ordered[best].played_at) - at))) best = i;
    }
    if (best < 0) {
      out.unlisted.push({ id: m.id, home });
      continue;
    }
    const storePred = best > 0 ? ordered[best - 1].track_id : null;
    if (m.pred && storePred !== m.pred) {
      out.excluded.push({ id: m.id, reason: `store's predecessor is ${storePred}, Home saw ${m.pred}` });
      continue;
    }
    const store = Number(ordered[best].skipped) === 1 ? "skip" : "listen";
    if (home === "pending") out.pending[store]++;
    else if ((home === "skip") === (store === "skip")) out.agree++;
    else out.disagree.push({ id: m.id, home, store });
  }
  return out;
}

async function main() {
  const user = scriptUserOrExit(process.argv.slice(2));
  const at = process.argv.indexOf("--since");
  const since = at >= 0 ? process.argv[at + 1] : new Date(Date.now() - 7 * 86_400_000).toISOString();
  const telemetry = createClient({ url: process.env.TELEMETRY_DATABASE_URL, authToken: process.env.TELEMETRY_AUTH_TOKEN });
  const core = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  await checkScriptDb(core, user, process.env.TURSO_DATABASE_URL);
  const metrics = (
    await telemetry.execute({
      sql: `SELECT ts, session, event, value, meta FROM client_metrics
            WHERE event IN ('np-change', 'handoff') AND user_id = ? AND ts >= ? ORDER BY ts`,
      args: [user.uid, since],
    })
  ).rows;
  const changes = metrics.filter((r) => r.event === "np-change");
  console.log(`np-change since ${since}: ${changes.length} rows`);
  for (const s of summarize(changes)) {
    console.log(`  ${s.path.padEnd(7)} ${s.kind.padEnd(8)} n=${String(s.n).padStart(4)}  p50 ${s.p50} ms  p95 ${s.p95} ms  max ${s.max} ms`);
  }
  const gaps = seqGaps(changes);
  console.log(`  sequence: ${gaps.sessions} tab sessions, ${gaps.missing} beacons missing`);
  const plays = (
    await core.execute({
      sql: "SELECT played_at, track_id, skipped FROM plays WHERE played_at >= ? ORDER BY played_at",
      args: [new Date(Date.parse(since) - 3_600_000).toISOString()],
    })
  ).rows;
  // A play Spotify has not listed 30 minutes after it ended is not coming (PLAN §7.4: p95 300 s).
  const settled = metrics.filter((r) => r.event === "handoff" && Number(parseMeta(r.meta).at) < Date.now() - 30 * 60_000);
  const v = joinVerdicts(settled, plays);
  console.log(
    `verdicts: ${v.judged} judged, ${v.agree} agree, ${v.disagree.length} disagree, pending → listen ${v.pending.listen} / skip ${v.pending.skip}, ${v.excluded.length} excluded, ${v.unlisted.length} never listed`,
  );
  for (const d of v.disagree) console.log(`  disagree ${d.id}: Home ${d.home}, store ${d.store}`);
  for (const e of v.excluded) console.log(`  excluded ${e.id}: ${e.reason}`);
  for (const u of v.unlisted) console.log(`  never listed ${u.id} (Home: ${u.home})`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
