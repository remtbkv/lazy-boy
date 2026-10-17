// The scripts' user (multi-user PLAN §6.2 layer 2 and 7, T10): every script that reads or writes a
// user's data names that user with a required `--user <uid>`, checked against the users a script
// can know before it opens anything. In Phase 1 that is the owner constant alone (OWNER_UID, read
// from .env.local with --env-file), so a run without --user, or for anyone else, exits 2 first.
// Phase 2 checks the uid against the app database's `users` rows and takes the db_name there.
//
// The database a script then opens must name the same owner (meta.owner_uid), as the app's own
// open does (src/lib/db.ts): a local copy without the key (a scratch file, an old dump) passes, a
// remote database without it does not (scripts/phase1-meta-keys.mjs writes it into Rem's).

const UID_RE = /^[a-z2-7]{12}$/;

export class ScriptUserError extends Error {}

/** `--user <uid>` from argv, checked; `adminOnly` refuses anyone but the admin (the backstop
 *  replay: the recorder captures Rem's account alone). */
export function scriptUser(argv, env = process.env, { adminOnly = false } = {}) {
  const at = argv.indexOf("--user");
  const uid = at >= 0 ? argv[at + 1] : undefined;
  if (!uid || !UID_RE.test(uid)) {
    throw new ScriptUserError("--user <uid> is required: the user whose data this run reads or writes");
  }
  const owner = env.OWNER_UID;
  if (!owner || !UID_RE.test(owner)) {
    throw new ScriptUserError("OWNER_UID is unset or malformed (run with --env-file=.env.local): no user is known");
  }
  // Phase 1 knows one user, the owner, who is also the admin.
  if (uid !== owner) throw new ScriptUserError(`no user ${uid}: Phase 1 knows OWNER_UID alone`);
  const admin = uid === owner;
  if (adminOnly && !admin) throw new ScriptUserError(`${uid} is not the admin; this script runs for the admin alone`);
  return { uid, admin, dbName: "lazyboy" };
}

/** scriptUser, or the reason on stderr and exit 2. */
export function scriptUserOrExit(argv, opts) {
  try {
    return scriptUser(argv, process.env, opts);
  } catch (e) {
    if (!(e instanceof ScriptUserError)) throw e;
    console.error(e.message);
    process.exit(2);
  }
}

/** The arguments with `--user <uid>` taken out, for a script's own parsing. */
export function withoutUser(argv) {
  const at = argv.indexOf("--user");
  return at >= 0 ? [...argv.slice(0, at), ...argv.slice(at + 2)] : argv;
}

/** Refuse a database that names another owner, or a remote one that names none; exit 2. */
export async function checkScriptDb(client, user, url) {
  let owner = null;
  try {
    const r = await client.execute("SELECT value FROM meta WHERE key = 'owner_uid'");
    owner = r.rows[0] ? String(r.rows[0].value) : null;
  } catch {
    owner = null; // no meta table: an empty file
  }
  let why = null;
  if (owner !== null && owner !== user.uid) why = `this database belongs to ${owner}, not ${user.uid}`;
  else if (owner === null && !url.startsWith("file:")) {
    why = "this database names no owner (meta.owner_uid): run scripts/phase1-meta-keys.mjs on it first";
  }
  if (why) {
    console.error(why);
    process.exit(2);
  }
}
