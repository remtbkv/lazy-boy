// The only way to change another user's status (docs/multi-user/PLAN.md §12.1; security R11): the
// runtime holds no admin mutation, so a stolen admin cookie cannot touch a friend's account.
//
//   node scripts/user.mjs --disable <uid>   # ends their sessions at their next request and their
//                                           #   sync at the next claim (status disabled, epoch + 1)
//   node scripts/user.mjs --enable <uid>    # disabled -> active
//   node scripts/user.mjs --remove <uid>    # the deletion job (§12.3), from the Mac: their database
//                                           #   destroyed, their rows and telemetry gone
//
// Every change also appends one line to the telemetry store's lifecycle log, which §12.5
// re-applies after an app-database restore; so it refuses to start without that store
// (TELEMETRY_DATABASE_URL, TELEMETRY_AUTH_TOKEN). Never the admin. The platform token comes from
// the Keychain item `lazyboy-turso-platform`, into memory only.
import { pathToFileURL } from "node:url";
import { LEASE_WINDOW_MS, runDeletion } from "../src/lib/deletion.ts";
import { appendLifecycle, macDeletionDeps, openApp, openTelemetry, platform, realDeps, UID_RE } from "./turso-mac.mjs";

const MOVES = {
  "--disable": { from: ["active", "needs_reconnect", "removed"], to: "disabled", action: "disabled", epoch: true },
  "--enable": { from: ["disabled"], to: "active", action: "enabled", epoch: false },
};

async function move(deps, app, tele, uid, m) {
  const row = (await app.execute({ sql: "SELECT status, is_admin FROM users WHERE uid = ?", args: [uid] })).rows[0];
  if (!row) throw new Error(`no user ${uid}`);
  if (Number(row.is_admin) === 1) throw new Error("refusing: never the admin");
  if (!m.from.includes(String(row.status))) throw new Error(`${uid} is ${row.status}; ${m.to} needs ${m.from.join(" or ")}`);
  const now = deps.now();
  const r = await app.execute({
    sql: `UPDATE users SET status = :to, status_at = :now${m.epoch ? ", session_epoch = session_epoch + 1" : ""}
          WHERE uid = :uid AND status = :from AND is_admin = 0`,
    args: { uid, to: m.to, from: String(row.status), now },
  });
  if (r.rowsAffected !== 1) throw new Error(`${uid} changed while this ran; nothing written`);
  await appendLifecycle(tele, { at: now, uid, action: m.action, by: "user.mjs" });
  deps.log(`${uid}: ${row.status} -> ${m.to}`);
  return 0;
}

async function remove(deps, plat, app, tele, uid) {
  const d = macDeletionDeps(deps, plat, app, tele, "user.mjs");
  for (let attempt = 0; attempt < 4; attempt++) {
    const o = await runDeletion(uid, d);
    if (o.kind === "done") {
      deps.log(`${uid}: deleted. Tell them to remove Lazy Boy at spotify.com/account/apps, and remove them in User Management.`);
      return 0;
    }
    if (o.kind === "refused") {
      deps.log(`${uid}: refused (${o.reason})`);
      return 1;
    }
    deps.log(`${uid}: ${o.step} pending${o.step === "window" ? ", waiting out the lease window" : ", retrying"}`);
    await deps.sleep(LEASE_WINDOW_MS + 1_000);
  }
  deps.log(`${uid}: still deleting; the daily chores retry it, or run --remove again`);
  return 1;
}

export async function main(argv, deps = realDeps()) {
  const [cmd, uid] = argv;
  if (!["--disable", "--enable", "--remove"].includes(cmd) || !UID_RE.test(uid ?? "")) {
    deps.log("usage: user.mjs --disable | --enable | --remove <uid>");
    return 2;
  }
  const tele = openTelemetry(deps);
  if (!tele) {
    deps.log("refusing: every change goes into the telemetry store's lifecycle log; set TELEMETRY_DATABASE_URL and TELEMETRY_AUTH_TOKEN");
    return 2;
  }
  const plat = platform(deps);
  const app = await openApp(deps, plat);
  try {
    await tele.execute("SELECT 1");
    return cmd === "--remove" ? await remove(deps, plat, app, tele, uid) : await move(deps, app, tele, uid, MOVES[cmd]);
  } finally {
    app.close();
    tele.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`user: ${e.message}`);
      process.exit(1);
    },
  );
}
