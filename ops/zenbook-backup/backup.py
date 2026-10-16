#!/usr/bin/env python3
"""Nightly offsite backups of the lazyboy stores, plus the backstop recorder: Rem's rows only.

Rem's ruling of Oct 15, 2026, 6:21 PM: "Backups keep only Rem's rows", because /privacy promises a
departed friend's data is gone within five days, backups included (docs/multi-user/RULINGS.md; it
replaces PLAN.md section 12.4's four-day copies of friends). So, every night:

1. The prune runs first and unconditionally, before anything is read or dumped: every backup file
   of a database that is not the admin's is deleted at any age, here and on OneDrive. That is every
   `lb-u-<uid>`: a friend's database has that name by construction and the admin's never does, so
   the prune needs no store to answer. Then each target's age prune as before.
2. Copies, each checked and stripped of `meta`'s `spotify_tokens%` and `lock:%` rows, then VACUUMed
   (no free page keeps a deleted row) before it is compressed and uploaded:
   - the admin's database (`users` row with is_admin = 1, so the name is read, not assumed), its
     /dump over HTTPS with a read-only token, checked with integrity_check, against count(*) per
     table taken on Turso around the dump, and its `meta.owner_uid` against the admin's uid;
   - `lazyboy-app`, the same way, keeping only the admin's rows: `users`, `user_tokens`,
     `sync_state`, `events` and `requests` by uid, `app_meta` without lock rows and without keys
     that name another uid. A table this file does not know fails the copy (nothing unreviewed
     ships);
   - the Zenbook's sqld file (telemetry, plus the frozen pre-cutover core copy until lane 1909
     drops it), with SQLite's online backup API, keeping only rows whose uid is the admin's or
     NULL; `api_log` and `client_metrics` must carry `user_id`, or the copy fails;
   - ~/lazyboy-recorder/backstop.db, the only copy of the recorder's plays (Rem's own token).
   Friends' databases are never dumped. A copy that fails a check is logged and NOT uploaded; the
   other targets still run.
3. The deletion check: no file here or on OneDrive names a database that is not the admin's
   (`lb-u-`), which is what the deletion job's day-five check reads (PLAN.md section 12.3 step 4).

Exit 1 if any copy or the check failed. Known answers: test_backup.py beside this file.
Env (the systemd unit's EnvironmentFile): LAZYBOY_TURSO_URL and LAZYBOY_TURSO_RO_TOKEN for the
admin's database, LAZYBOY_APP_URL and LAZYBOY_APP_RO_TOKEN for `lazyboy-app`.
"""
import glob, gzip, json, os, re, shutil, sqlite3, subprocess, time, urllib.request

HOME = os.path.expanduser("~/lazyboy-backup")
KEEP_LOCAL_DAYS = 14
TURSO_ROOT, TURSO_REMOTE = os.path.join(HOME, "turso"), "onedrive-backup:lazyboy-turso"
# Remote retention in days. Every copy holds only the admin's rows, so each keeps the admin's 60
# (PLAN 12.4's four days existed to age friends' rows out, and no copy holds one now).
ADMIN_KEEP = 60
APP_DB, APP_KEEP = "lazyboy-app", 60
ZENBOOK_SRC = os.path.expanduser("~/lazyboy-sqld/data/dbs/default/data")
ZENBOOK_REMOTE, ZENBOOK_KEEP = "onedrive-backup:lazyboy-db", 60
BACKSTOP_SRC = os.path.expanduser("~/lazyboy-recorder/backstop.db")
BACKSTOP_REMOTE, BACKSTOP_KEEP = "onedrive-backup:lazyboy-backstop", 60
STRIP = "DELETE FROM meta WHERE key LIKE 'spotify_tokens%' OR key LIKE 'lock:%'"
FRIEND_DB = "lb-u-"  # every friend's database is lb-u-<uid> (invite.mjs, deletion.ts)
UID_RE = re.compile(r"^[a-z2-7]{12}$")  # src/lib/identity.ts
# The app database's tables (src/lib/app-schema.ts) and the column that names whose row it is.
APP_TABLES = {"users": "uid", "user_tokens": "uid", "sync_state": "uid", "events": "uid", "requests": "uid", "app_meta": None}
# Telemetry tables that hold one user's rows and must say whose.
TELEMETRY_PER_USER = ("api_log", "client_metrics")


def log(msg):
    line = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " " + msg
    print(line, flush=True)
    with open(os.path.join(HOME, "backup.log"), "a") as f:
        f.write(line + "\n")


def rclone(*args):
    return subprocess.run(["rclone", *args], capture_output=True, text=True)


def not_found(r):
    return r.returncode == 3 and "directory not found" in r.stderr


def prune_friends():
    """Every backup of a friend's database, deleted at any age, here and on OneDrive. A database
    that is not the admin's is a friend's `lb-u-<uid>` by construction (invite.mjs creates them,
    and the deletion job refuses any other name), so this needs nothing read first: it runs even
    when no store answers. Any other name (Rem's, under a name a restore gave it) is left alone."""
    gone, failed = [], []
    if os.path.isdir(TURSO_ROOT):
        for n in sorted(os.listdir(TURSO_ROOT)):
            if n.startswith(FRIEND_DB):
                shutil.rmtree(os.path.join(TURSO_ROOT, n), ignore_errors=True)
                gone.append("local:" + n)
    r = rclone("lsf", "--dirs-only", TURSO_REMOTE)
    if r.returncode != 0 and not not_found(r):
        failed.append("lsf rc=%d %s" % (r.returncode, r.stderr.strip()[:200]))
    for n in ([] if r.returncode != 0 else [x.rstrip("/") for x in r.stdout.split()]):
        if not n.startswith(FRIEND_DB):
            continue
        p = rclone("purge", "%s/%s" % (TURSO_REMOTE, n))
        if p.returncode == 0:
            gone.append("remote:" + n)
        else:
            failed.append("purge %s rc=%d %s" % (n, p.returncode, p.stderr.strip()[:200]))
    log("prune friends: %d removed%s%s" % (len(gone), (" (" + ", ".join(gone) + ")") if gone else "",
                                            (" FAILED " + "; ".join(failed)) if failed else ""))


def prune(name, local_dir, remote, keep_days):
    os.makedirs(local_dir, exist_ok=True)
    cutoff, gone = time.time() - KEEP_LOCAL_DAYS * 86400, 0
    for p in glob.glob(os.path.join(local_dir, "*.db.gz")):
        if os.path.getmtime(p) < cutoff:
            os.remove(p)
            gone += 1
    # sqlite leaves -wal/-shm beside a WAL-mode copy opened read-only; none should survive a run
    for p in glob.glob(os.path.join(local_dir, "*.db-wal")) + glob.glob(os.path.join(local_dir, "*.db-shm")):
        os.remove(p)
        gone += 1
    r = rclone("delete", remote, "--min-age", "%dd" % keep_days)
    log("prune %s: %d local file(s) removed, remote --min-age %dd rc=%d %s"
        % (name, gone, keep_days, r.returncode, r.stderr.strip()[:200]))


def tables(conn):
    return [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def columns(conn, table):
    return [r[1] for r in conn.execute('PRAGMA table_info("%s")' % table)]


def local_counts(path):
    c = sqlite3.connect("file:" + path + "?mode=ro", uri=True)
    try:
        return {t: c.execute('SELECT count(*) FROM "%s"' % t).fetchone()[0] for t in tables(c)}
    finally:
        c.close()


def keep_admin_app_rows(c, admin_uid):
    """The `lazyboy-app` copy: only the admin's rows. Unknown tables fail the copy."""
    unknown = [t for t in tables(c) if t not in APP_TABLES]
    if unknown:
        raise RuntimeError("unreviewed app table(s) %s: add each to APP_TABLES with its uid column" % ",".join(unknown))
    for t, col in APP_TABLES.items():
        if col and t in tables(c):
            c.execute('DELETE FROM "%s" WHERE "%s" IS NULL OR "%s" <> ?' % (t, col, col), (admin_uid,))
    if "app_meta" in tables(c):
        c.execute("DELETE FROM app_meta WHERE key LIKE 'lock:%'")
        other = [k for (k,) in c.execute("SELECT key FROM app_meta")
                 if any(UID_RE.match(part) and part != admin_uid for part in k.split(":"))]
        c.executemany("DELETE FROM app_meta WHERE key = ?", [(k,) for k in other])
    n = c.execute("SELECT count(*), sum(is_admin = 1) FROM users").fetchone()
    if n != (1, 1):
        raise RuntimeError("app copy: users holds %r after the filter, not the admin alone" % (n,))


def keep_admin_telemetry(c, admin_uid):
    """The telemetry copy: rows whose uid is the admin's or NULL (written before Phase 1 tagged them)."""
    for t in TELEMETRY_PER_USER:
        if t in tables(c) and "user_id" not in columns(c, t):
            raise RuntimeError("telemetry %s has no user_id: friends' rows cannot be told apart" % t)
    for t in tables(c):
        for col in ("user_id", "uid"):
            if col in columns(c, t):
                c.execute('DELETE FROM "%s" WHERE "%s" IS NOT NULL AND "%s" <> ?' % (t, col, col), (admin_uid,))


def strip_and_ship(raw, remote, keep=None):
    """Keep only what `keep` allows, delete token/lock rows, VACUUM, gzip, upload. Returns the .gz path."""
    c = sqlite3.connect(raw)
    if keep:
        keep(c)
    if "meta" in tables(c):
        n = c.execute(STRIP).rowcount
    else:
        n = 0
    c.commit()
    c.execute("PRAGMA journal_mode=DELETE")
    c.execute("VACUUM")
    c.close()
    gz = raw + ".gz"
    with open(raw, "rb") as f_in, gzip.open(gz, "wb", compresslevel=6) as f_out:
        shutil.copyfileobj(f_in, f_out)
    os.remove(raw)
    up = rclone("copy", gz, remote, "--retries", "3")
    if up.returncode != 0:
        raise RuntimeError("rclone " + up.stderr.strip()[:200])
    return gz, n


def integrity(raw):
    c = sqlite3.connect(raw)
    try:
        return c.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        c.close()


def sqlite_file(name, src, local_dir, remote, slack, keep=None):
    """Online-backup copy of a live SQLite file. `slack`: rows the live file may gain or lose
    while the copy runs (it keeps taking writes)."""
    raw = os.path.join(local_dir, "%s-%s.db" % (name, time.strftime("%Y%m%d-%H%M", time.gmtime())))
    s = sqlite3.connect("file:" + src + "?mode=ro", uri=True)
    d = sqlite3.connect(raw)
    with d:
        s.backup(d)
    d.execute("PRAGMA journal_mode=DELETE")
    d.close()
    s.close()
    v = integrity(raw)
    if v != "ok":
        raise RuntimeError("integrity_check " + str(v))
    live, copy = local_counts(src), local_counts(raw)
    off = {t: (live[t], copy.get(t)) for t in live if copy.get(t) is None or abs(copy[t] - live[t]) > slack}
    if off:
        raise RuntimeError("counts live vs copy " + json.dumps(off))
    gz, n = strip_and_ship(raw, remote, keep)
    return "%s %dKB stripped=%d %s" % (os.path.basename(gz), os.path.getsize(gz) // 1024, n,
                                       " ".join("%s=%d" % kv for kv in sorted(local_counts_gz(gz).items())))


def local_counts_gz(gz):
    """Row counts of what was shipped, after the filter: the log line says what the copy holds."""
    raw = gz[:-3] + ".check"
    with gzip.open(gz) as f_in, open(raw, "wb") as f_out:
        shutil.copyfileobj(f_in, f_out)
    try:
        return local_counts(raw)
    finally:
        os.remove(raw)


def turso_counts(url, token):
    """count(*) per table on Turso, one pipeline request."""
    names = pipeline(url, token, ["SELECT name FROM sqlite_master WHERE type='table' "
                                  "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%' ORDER BY name"])[0]
    ts = [r[0]["value"] for r in names]
    res = pipeline(url, token, ['SELECT count(*) FROM "%s"' % t for t in ts])
    return {t: int(r[0][0]["value"]) for t, r in zip(ts, res)}


def pipeline(url, token, sqls):
    body = {"requests": [{"type": "execute", "stmt": {"sql": s}} for s in sqls] + [{"type": "close"}]}
    req = urllib.request.Request(url + "/v2/pipeline", data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + token,
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        out = json.load(r)["results"]
    rows = []
    for o in out[:len(sqls)]:
        if o["type"] != "ok":
            raise RuntimeError("pipeline " + json.dumps(o)[:200])
        rows.append(o["response"]["result"]["rows"])
    return rows


def admin_identity():
    """The admin's uid and database name, from `lazyboy-app`'s users row (is_admin = 1)."""
    found = pipeline(os.environ["LAZYBOY_APP_URL"], os.environ["LAZYBOY_APP_RO_TOKEN"],
                     ["SELECT uid, db_name FROM users WHERE is_admin = 1"])[0]
    if len(found) != 1:
        raise RuntimeError("users holds %d admin rows, not one" % len(found))
    uid, db = found[0][0].get("value"), found[0][1].get("value")
    if not uid or not UID_RE.match(uid) or not db or db.startswith(FRIEND_DB):
        raise RuntimeError("the admin row names uid %r, database %r" % (uid, db))
    return uid, db


def owner_of(path):
    c = sqlite3.connect(path)
    try:
        r = c.execute("SELECT value FROM meta WHERE key = 'owner_uid'").fetchone() if "meta" in tables(c) else None
        return r[0] if r else None
    finally:
        c.close()


def turso(db, url, token, local_dir, remote, keep=None, owner=None):
    before = turso_counts(url, token)
    req = urllib.request.Request(url + "/dump", headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=300) as r:
        if r.status != 200:
            raise RuntimeError("dump HTTP %d" % r.status)
        dump = r.read().decode()
    if not dump.rstrip().endswith("COMMIT;"):
        raise RuntimeError("dump does not end in COMMIT; (%d bytes)" % len(dump))
    after = turso_counts(url, token)
    raw = os.path.join(local_dir, "%s-%s.db" % (db, time.strftime("%Y%m%d-%H%M", time.gmtime())))
    c = sqlite3.connect(raw)
    c.executescript(dump)
    c.close()
    v = integrity(raw)
    if v != "ok":
        raise RuntimeError("integrity_check " + str(v))
    if owner is not None and owner_of(raw) != owner:
        raise RuntimeError("meta.owner_uid of %s is not the admin's" % db)
    copy = local_counts(raw)
    # Turso keeps taking writes, so a table may move between the two counts; the dump's count
    # must sit between them (inclusive). Outside that range is a lost or invented row.
    off = {t: (before.get(t), copy.get(t), after[t]) for t in after
           if copy.get(t) is None or not min(before.get(t, -1), after[t]) <= copy[t] <= max(before.get(t, -1), after[t])}
    extra = sorted(set(copy) - set(after))
    if off or extra:
        raise RuntimeError("counts turso vs dump " + json.dumps(off) + " extra=" + json.dumps(extra))
    gz, n = strip_and_ship(raw, remote, keep)
    return "%s %dKB stripped=%d %s" % (os.path.basename(gz), os.path.getsize(gz) // 1024, n,
                                       " ".join("%s=%d" % kv for kv in sorted(local_counts_gz(gz).items())))


def check_no_friend_files():
    """The deletion check: no backup file, here or on OneDrive, names a friend's database."""
    local = [os.path.join(dp, n) for dp, ds, fs in os.walk(HOME) for n in ds + fs]
    remote, errors = [], []
    for rem in (TURSO_REMOTE, ZENBOOK_REMOTE, BACKSTOP_REMOTE):
        r = rclone("lsf", "-R", rem)
        if r.returncode == 0:
            remote += [rem + "/" + x for x in r.stdout.split()]
        elif not not_found(r):
            errors.append("%s rc=%d %s" % (rem, r.returncode, r.stderr.strip()[:200]))
    named = sorted({m.group(0) for p in local + remote for m in [re.search(FRIEND_DB + r"[a-z2-7]*", p)] if m})
    if errors or named:
        log("FAIL check: backups naming a friend's database %s%s" % (named, (" unreadable " + "; ".join(errors)) if errors else ""))
        return False
    log("check ok: no backup names a friend's database (local %d, remote %d entries)" % (len(local), len(remote)))
    return True


def main():
    os.makedirs(HOME, exist_ok=True)
    prune_friends()  # first, before anything is read or dumped, whatever fails after it
    failed = 0
    try:
        admin = admin_identity()
    except Exception as e:
        admin = None
        failed += 1
        log("FAIL admin %s: %s (no copy that needs the admin runs tonight)" % (type(e).__name__, str(e)[:300]))

    jobs = []
    if admin:
        uid, db = admin
        d = os.path.join(TURSO_ROOT, db)
        rem = "%s/%s" % (TURSO_REMOTE, db)
        url, token = os.environ["LAZYBOY_TURSO_URL"], os.environ["LAZYBOY_TURSO_RO_TOKEN"]
        jobs.append(("turso:" + db, d, rem, ADMIN_KEEP,
                     lambda db=db, url=url, token=token, d=d, rem=rem, uid=uid: turso(db, url, token, d, rem, owner=uid)))
        d = os.path.join(TURSO_ROOT, APP_DB)
        rem = "%s/%s" % (TURSO_REMOTE, APP_DB)
        url, token = os.environ["LAZYBOY_APP_URL"], os.environ["LAZYBOY_APP_RO_TOKEN"]
        jobs.append(("turso:" + APP_DB, d, rem, APP_KEEP,
                     lambda url=url, token=token, d=d, rem=rem, uid=uid:
                     turso(APP_DB, url, token, d, rem, keep=lambda c: keep_admin_app_rows(c, uid))))
        d = os.path.join(HOME, "snapshots")
        jobs.append(("zenbook", d, ZENBOOK_REMOTE, ZENBOOK_KEEP,
                     lambda d=d, uid=uid: sqlite_file("zenbook", ZENBOOK_SRC, d, ZENBOOK_REMOTE, 50,
                                                      keep=lambda c: keep_admin_telemetry(c, uid))))
    d = os.path.join(HOME, "backstop")
    jobs.append(("backstop", d, BACKSTOP_REMOTE, BACKSTOP_KEEP,
                 lambda d=d: sqlite_file("backstop", BACKSTOP_SRC, d, BACKSTOP_REMOTE, 5)))

    for name, d, rem, keep, _ in jobs:
        prune(name, d, rem, keep)
    for name, d, rem, keep, run in jobs:
        try:
            log("ok %s %s -> %s" % (name, run(), rem))
        except Exception as e:
            failed += 1
            log("FAIL %s %s: %s" % (name, type(e).__name__, str(e)[:300]))
            for p in glob.glob(os.path.join(d, "*.db")) + glob.glob(os.path.join(d, "*.check")):
                os.remove(p)  # never leave an unstripped raw copy
    if not check_no_friend_files():
        failed += 1
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
