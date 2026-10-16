// Sign-up's Mac half (RULINGS Oct 15 12:46 PM; docs/multi-user/PLAN.md §12.1): a friend asks at
// /join; Rem adds their e-mail in Spotify's dashboard (User Management) and approves the request
// here; the script prints the join link to send them; they connect.
//
//   node scripts/invite.mjs --list                # the open requests, with their e-mails, and the
//                                                 #   unclaimed invites. Rem runs it; an agent never
//                                                 #   does (agents stay off friends' rows), and it
//                                                 #   refuses inside a Claude Code session
//   node scripts/invite.mjs --approve <request>   # provision lb-u-<uid> and print the join link;
//                                                 #   on an approved request, a new link
//   node scripts/invite.mjs --revoke <uid>        # withdraw an unclaimed invite (or a crashed
//                                                 #   approval's provisioning row) and its database
//   node scripts/invite.mjs --decline <request>   # delete a pending request (a stranger's)
//
// --approve refuses once five people hold places (Spotify's User Management cap, Rem included);
// inserts the users row as `provisioning`, which reserves the uid; creates `lb-u-<uid>` in group
// `default`, applies the user schema and writes the four meta keys (PLAN §4.5); then sets the row
// `invited` and the request `approved` with the join link's token hash. A crash leaves a
// `provisioning` row that --approve on the same request resumes and --revoke removes. The 14-day
// expiry of an unclaimed invite runs in the daily chores. The platform token comes from the
// Keychain item `lazyboy-turso-platform`, into memory only; it is never printed.
import { pathToFileURL } from "node:url";
import { withdrawInvite } from "../src/lib/deletion.ts";
import { joinTokenHash } from "../src/lib/request-cookie.ts";
import { USER_SCHEMA_STATEMENTS, userMetaStatement } from "../src/lib/user-schema.ts";
import { macDeletionDeps, openApp, openByName, platform, realDeps, UID_RE } from "./turso-mac.mjs";

const SEATS = 5;
// Production (docs/quota-forensic/BRIDGE.md); LAZYBOY_ORIGIN overrides it (lane 28's rehearsal).
const ORIGIN = "https://lazy-spotify.vercel.app";
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

function newUid(deps) {
  let out = "";
  for (const b of deps.randomBytes(12)) out += B32[b & 31];
  return out;
}

async function list(deps) {
  if (deps.env.CLAUDECODE) {
    deps.log("refusing: --list prints friends' e-mails, and agents stay off friends' rows (RULES 11). Rem runs it in his own terminal.");
    return 2;
  }
  const app = await openApp(deps, platform(deps));
  try {
    const r = await app.execute(
      `SELECT r.id, r.status, r.email, r.name, r.created_at, r.uid, u.status AS user_status
       FROM requests r LEFT JOIN users u ON u.uid = r.uid
       WHERE r.status IN ('pending', 'approved') ORDER BY r.created_at`,
    );
    if (!r.rows.length) deps.log("no open requests");
    for (const x of r.rows) {
      const when = new Date(Number(x.created_at)).toISOString().slice(0, 16).replace("T", " ");
      deps.log(`${x.id}  ${x.status}${x.uid ? ` (uid ${x.uid}, ${x.user_status})` : ""}  ${x.email}  "${x.name}"  asked ${when} UTC`);
    }
    return 0;
  } finally {
    app.close();
  }
}

async function approve(deps, rid) {
  if (!UID_RE.test(rid ?? "")) throw new Error("--approve needs a request id (from --list)");
  const plat = platform(deps);
  const app = await openApp(deps, plat);
  try {
    const now = deps.now();
    const req = (await app.execute({ sql: "SELECT id, email, status, uid FROM requests WHERE id = ?", args: [rid] })).rows[0];
    if (!req) throw new Error(`no request ${rid}`);
    if (req.status !== "pending" && req.status !== "approved") throw new Error(`request ${rid} is ${req.status}`);
    let uid = req.uid == null ? null : String(req.uid);
    const row = uid ? (await app.execute({ sql: "SELECT status FROM users WHERE uid = ?", args: [uid] })).rows[0] : null;
    if (uid && row && row.status !== "provisioning" && row.status !== "invited") throw new Error(`request ${rid}'s user ${uid} is ${row.status}`);

    if (!uid || !row) {
      // Five places: Rem and four friends, every row not yet deleted holding one.
      const held = Number((await app.execute("SELECT count(*) AS n FROM users WHERE status <> 'deleted'")).rows[0].n);
      if (held >= SEATS) throw new Error(`refusing: ${held} people already hold Lazy Boy's ${SEATS} places`);
      uid = newUid(deps);
      // One transaction: the request is linked first, and the row is inserted only if this run's
      // link landed, so two approvals racing on one request cannot leave a stray reservation.
      const [link, ins] = await app.batch(
        [
          { sql: "UPDATE requests SET uid = :uid WHERE id = :rid AND status = 'pending' AND uid IS NULL", args: { uid, rid } },
          {
            sql: `INSERT INTO users (uid, account_id, spotify_id, db_name, status, status_at, is_admin, session_epoch, invited_at)
                  SELECT :uid, NULL, :sid, :db, 'provisioning', :now, 0, 0, :now
                  WHERE EXISTS (SELECT 1 FROM requests WHERE id = :rid AND uid = :uid)`,
            args: { uid, rid, sid: `invite:${rid}`, db: `lb-u-${uid}`, now },
          },
        ],
        "write",
      );
      if (ins.rowsAffected !== 1 || link.rowsAffected !== 1) throw new Error(`request ${rid} changed while approving it; run --list`);
      deps.log(`reserved uid ${uid} (provisioning)`);
    }

    // The friend's database, at today's version, with the four keys. Each step is re-runnable.
    const name = `lb-u-${uid}`;
    if (!(await plat.database(name))) await plat.create(name);
    const user = await openByName(deps, plat, name);
    try {
      for (const s of USER_SCHEMA_STATEMENTS) await user.execute(s);
      await user.execute(userMetaStatement(uid, deps.randomBytes(16).toString("hex")));
      const owner = (await user.execute("SELECT value FROM meta WHERE key = 'owner_uid'")).rows[0]?.value;
      if (owner !== uid) throw new Error(`${name} names owner ${owner}, not ${uid}: refusing`);
    } finally {
      user.close();
    }

    const token = deps.randomBytes(32).toString("base64url");
    const [, done] = await app.batch(
      [
        { sql: "UPDATE users SET status = 'invited', status_at = :now WHERE uid = :uid AND status = 'provisioning'", args: { uid, now } },
        {
          sql: `UPDATE requests SET status = 'approved', status_at = :now, join_hash = :h
                WHERE id = :rid AND uid = :uid AND status IN ('pending', 'approved')
                  AND EXISTS (SELECT 1 FROM users WHERE uid = :uid AND status = 'invited')`,
          args: { uid, rid, now, h: joinTokenHash(token) },
        },
      ],
      "write",
    );
    if (done.rowsAffected !== 1) throw new Error(`request ${rid} could not be marked approved`);
    const origin = deps.env.LAZYBOY_ORIGIN || ORIGIN;
    deps.log(`approved ${rid} as uid ${uid}.`);
    deps.log(`1. If you have not yet: add ${req.email} in the Spotify dashboard, User Management (name and that e-mail).`);
    deps.log(`2. Send them this link (it works once they connect, for 14 days): ${origin}/api/join/link?t=${token}`);
    return 0;
  } finally {
    app.close();
  }
}

async function revoke(deps, uid) {
  if (!UID_RE.test(uid ?? "")) throw new Error("--revoke needs a uid");
  const plat = platform(deps);
  const app = await openApp(deps, plat);
  try {
    const noTelemetry = {
      deleteUser: async () => {
        throw new Error("unused");
      },
      appendLifecycle: async () => {
        throw new Error("unused");
      },
    };
    const o = await withdrawInvite(uid, { ...macDeletionDeps(deps, plat, app, null, "invite.mjs"), telemetry: noTelemetry });
    deps.log(o.kind === "done" ? `withdrew ${uid}` : `not withdrawn: ${o.kind} ${o.reason ?? o.step}`);
    return o.kind === "done" ? 0 : 1;
  } finally {
    app.close();
  }
}

async function decline(deps, rid) {
  if (!UID_RE.test(rid ?? "")) throw new Error("--decline needs a request id");
  const app = await openApp(deps, platform(deps));
  try {
    const r = await app.execute({ sql: "DELETE FROM requests WHERE id = ? AND status = 'pending' AND uid IS NULL", args: [rid] });
    deps.log(r.rowsAffected ? `deleted request ${rid}` : `no pending request ${rid} (an approved one is withdrawn with --revoke <uid>)`);
    return r.rowsAffected ? 0 : 1;
  } finally {
    app.close();
  }
}

export async function main(argv, deps = realDeps()) {
  const [cmd, arg] = argv;
  if (cmd === "--list") return list(deps);
  if (cmd === "--approve") return approve(deps, arg);
  if (cmd === "--revoke") return revoke(deps, arg);
  if (cmd === "--decline") return decline(deps, arg);
  deps.log("usage: invite.mjs --list | --approve <request id> | --revoke <uid> | --decline <request id>");
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`invite: ${e.message}`);
      process.exit(1);
    },
  );
}
