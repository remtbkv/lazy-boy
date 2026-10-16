#!/usr/bin/env python3
"""Nightly offsite backups of both lazyboy stores, plus the backstop recorder.

Since the Oct 16 2026 cutover (docs/STORE_MIGRATION.md section 9) the app's core data lives on
Turso (`lazyboy`) and the Zenbook's sqld keeps the telemetry tables. This job copies:

- each Turso database in TURSO_DBS: its /dump over HTTPS with a read-only token (from
  ~/lazyboy-backup/env, loaded by the systemd unit), loaded into a fresh SQLite file, checked
  with integrity_check and against count(*) per table taken on Turso around the dump;
- the Zenbook sqld file (telemetry, plus the frozen pre-cutover core copy until lane 1909 drops
  it), with SQLite's online backup API as before;
- ~/lazyboy-recorder/backstop.db, the only copy of the recorder's plays.

Every copy has meta's `spotify_tokens%` and `lock:%` rows deleted (then VACUUM, so no free page
keeps them) before it is compressed: a restore brings back no Spotify token and Rem signs in
again. Each target prunes first and unconditionally, so a failed night still prunes. A copy that
fails a check is logged and NOT uploaded; the other targets still run. Exit 1 if any failed.
"""
import glob, gzip, json, os, shutil, sqlite3, subprocess, time, urllib.request

HOME = os.path.expanduser("~/lazyboy-backup")
KEEP_LOCAL_DAYS = 14
# (database, remote retention in days). Remote: onedrive-backup:lazyboy-turso/<database>.
TURSO_DBS = [("lazyboy", 60)]
ZENBOOK_SRC = os.path.expanduser("~/lazyboy-sqld/data/dbs/default/data")
ZENBOOK_REMOTE, ZENBOOK_KEEP = "onedrive-backup:lazyboy-db", 60
BACKSTOP_SRC = os.path.expanduser("~/lazyboy-recorder/backstop.db")
BACKSTOP_REMOTE, BACKSTOP_KEEP = "onedrive-backup:lazyboy-backstop", 60
STRIP = "DELETE FROM meta WHERE key LIKE 'spotify_tokens%' OR key LIKE 'lock:%'"


def log(msg):
    line = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " " + msg
    print(line, flush=True)
    with open(os.path.join(HOME, "backup.log"), "a") as f:
        f.write(line + "\n")


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
    r = subprocess.run(["rclone", "delete", remote, "--min-age", "%dd" % keep_days],
                       capture_output=True, text=True)
    log("prune %s: %d local file(s) removed, remote --min-age %dd rc=%d %s"
        % (name, gone, keep_days, r.returncode, r.stderr.strip()[:200]))


def tables(conn):
    return [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]


def local_counts(path):
    c = sqlite3.connect("file:" + path + "?mode=ro", uri=True)
    try:
        return {t: c.execute('SELECT count(*) FROM "%s"' % t).fetchone()[0] for t in tables(c)}
    finally:
        c.close()


def strip_and_ship(raw, remote):
    """Delete token/lock rows, VACUUM, gzip, upload. Returns the .gz path."""
    c = sqlite3.connect(raw)
    if "meta" in tables(c):
        n = c.execute(STRIP).rowcount
        c.commit()
    else:
        n = 0
    c.execute("PRAGMA journal_mode=DELETE")
    c.execute("VACUUM")
    c.close()
    gz = raw + ".gz"
    with open(raw, "rb") as f_in, gzip.open(gz, "wb", compresslevel=6) as f_out:
        shutil.copyfileobj(f_in, f_out)
    os.remove(raw)
    up = subprocess.run(["rclone", "copy", gz, remote, "--retries", "3"], capture_output=True, text=True)
    if up.returncode != 0:
        raise RuntimeError("rclone " + up.stderr.strip()[:200])
    return gz, n


def integrity(raw):
    c = sqlite3.connect(raw)
    try:
        return c.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        c.close()


def sqlite_file(name, src, local_dir, remote, slack):
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
    gz, n = strip_and_ship(raw, remote)
    return "%s %dKB stripped=%d %s" % (os.path.basename(gz), os.path.getsize(gz) // 1024, n,
                                       " ".join("%s=%d" % kv for kv in sorted(copy.items())))


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


def turso(db, local_dir, remote):
    url, token = os.environ["LAZYBOY_TURSO_URL"], os.environ["LAZYBOY_TURSO_RO_TOKEN"]
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
    copy = local_counts(raw)
    # Turso keeps taking writes, so a table may move between the two counts; the dump's count
    # must sit between them (inclusive). Outside that range is a lost or invented row.
    off = {t: (before.get(t), copy.get(t), after[t]) for t in after
           if copy.get(t) is None or not min(before.get(t, -1), after[t]) <= copy[t] <= max(before.get(t, -1), after[t])}
    extra = sorted(set(copy) - set(after))
    if off or extra:
        raise RuntimeError("counts turso vs dump " + json.dumps(off) + " extra=" + json.dumps(extra))
    gz, n = strip_and_ship(raw, remote)
    return "%s %dKB stripped=%d %s" % (os.path.basename(gz), os.path.getsize(gz) // 1024, n,
                                       " ".join("%s=%d" % kv for kv in sorted(copy.items())))


def main():
    jobs = []
    for db, keep in TURSO_DBS:
        d, rem = os.path.join(HOME, "turso", db), "onedrive-backup:lazyboy-turso/" + db
        jobs.append(("turso:" + db, d, rem, keep, lambda db=db, d=d, rem=rem: turso(db, d, rem)))
    d = os.path.join(HOME, "snapshots")
    jobs.append(("zenbook", d, ZENBOOK_REMOTE, ZENBOOK_KEEP,
                 lambda d=d: sqlite_file("zenbook", ZENBOOK_SRC, d, ZENBOOK_REMOTE, 50)))
    d = os.path.join(HOME, "backstop")
    jobs.append(("backstop", d, BACKSTOP_REMOTE, BACKSTOP_KEEP,
                 lambda d=d: sqlite_file("backstop", BACKSTOP_SRC, d, BACKSTOP_REMOTE, 5)))

    for name, d, rem, keep, _ in jobs:
        prune(name, d, rem, keep)
    failed = 0
    for name, d, rem, keep, run in jobs:
        try:
            log("ok %s %s -> %s" % (name, run(), rem))
        except Exception as e:
            failed += 1
            log("FAIL %s %s: %s" % (name, type(e).__name__, str(e)[:300]))
            for p in glob.glob(os.path.join(d, "*.db")):  # never leave an unstripped raw copy
                os.remove(p)
    raise SystemExit(1 if failed else 0)


if __name__ == "__main__":
    main()
