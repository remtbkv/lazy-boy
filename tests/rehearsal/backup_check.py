#!/usr/bin/env python3
"""The rehearsal's backup runs (docs/multi-user/REHEARSAL.md, checks 7 and 9): the branch's
ops/zenbook-backup/backup.py against copies of the rehearsal's throwaway stores, through lane 19's
fixtures (test_backup.py's FakeTurso: /v2/pipeline and /dump over local files; fake_rclone.py:
OneDrive as a local directory). Prints one JSON object: what the run did and what it left.

  python3 -I tests/rehearsal/backup_check.py deletion --stores S --work W --admin-uid U --friend A --deleted B [--fail purge]
  python3 -I tests/rehearsal/backup_check.py clock --stores S --work W --admin-uid U [--days 2]

`deletion` plants a backup of B's database dated five days back and the admin's own older copies
(here and on "OneDrive"), then runs the job once. `clock` plants the admin's copies around both
age limits and runs the job with LAZYBOY_BACKUP_NOW set `--days` on.
"""
import argparse, gzip, hashlib, json, os, shutil, sqlite3, stat, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OPS = os.path.join(REPO, "ops", "zenbook-backup")
sys.path.insert(0, OPS)
import test_backup as tb  # noqa: E402  (lane 19's fixtures: FakeTurso, TOKENS)

DAY = 86400


def stamp(t):
    return time.strftime("%Y%m%d-%H%M", time.gmtime(t))


def gz_file(path, payload, mtime):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, "wb") as f:
        f.write(payload)
    os.utime(path, (mtime, mtime))


def digest(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()[:16]


def copy_db(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    # SQLite's online backup: a consistent copy of a WAL-mode file, the live one opened read-only.
    s = sqlite3.connect("file:" + src + "?mode=ro", uri=True)
    d = sqlite3.connect(dst)
    with d:
        s.backup(d)
    d.close()
    s.close()


def setup(a):
    home, remote, bin_, turso = (os.path.join(a.work, x) for x in ("home", "remote", "bin", "turso"))
    fresh = not os.path.isdir(home)
    for d in (home, remote, bin_, turso, os.path.join(home, "lazyboy-backup")):
        os.makedirs(d, exist_ok=True)
    shutil.copy(os.path.join(OPS, "fake_rclone.py"), os.path.join(bin_, "rclone"))
    os.chmod(os.path.join(bin_, "rclone"), stat.S_IRWXU)
    files = {"lazyboy": os.path.join(turso, "lazyboy.db"), "lazyboy-app": os.path.join(turso, "lazyboy-app.db")}
    for f in a.friend or []:
        files["lb-u-" + f] = os.path.join(turso, "lb-u-%s.db" % f)
    for name, path in files.items():
        copy_db(os.path.join(a.stores, name + ".db"), path)
    tele = os.path.join(home, "lazyboy-sqld/data/dbs/default/data")
    copy_db(os.path.join(a.stores, "telemetry.db"), tele)
    backstop = os.path.join(home, "lazyboy-recorder/backstop.db")
    if not os.path.exists(backstop):
        os.makedirs(os.path.dirname(backstop), exist_ok=True)
        tb.make_db(backstop, ["CREATE TABLE plays (id INTEGER PRIMARY KEY, track_id TEXT)", "INSERT INTO plays (track_id) VALUES ('ADMINxt001')"])
    # Every database answers with its own token, friends' included, so a dump of one would succeed
    # and be recorded rather than refused.
    for name in files:
        tb.TOKENS[name] = "tok-" + name
    return home, remote, bin_, files, fresh


def run_backup(a, home, remote, bin_, fake, extra):
    env = {
        "HOME": home,
        "PATH": bin_ + os.pathsep + os.environ.get("PATH", ""),
        "FAKE_RCLONE_ROOT": remote,
        "LAZYBOY_TURSO_URL": fake.base + "lazyboy",
        "LAZYBOY_TURSO_RO_TOKEN": tb.TOKENS["lazyboy"],
        "LAZYBOY_APP_URL": fake.base + "lazyboy-app",
        "LAZYBOY_APP_RO_TOKEN": tb.TOKENS["lazyboy-app"],
        **extra,
    }
    log_path = os.path.join(home, "lazyboy-backup/backup.log")
    start = os.path.getsize(log_path) if os.path.exists(log_path) else 0
    p = subprocess.run([sys.executable, "-I", os.path.join(OPS, "backup.py")], env=env, capture_output=True, text=True, timeout=300)
    with open(log_path) as f:
        f.seek(start)
        log = f.read()
    return p.returncode, log, p.stderr[-500:]


def uploaded(remote, sub, work):
    d = os.path.join(remote, "onedrive-backup", sub)
    names = sorted(n for n in os.listdir(d) if n.endswith(".db.gz")) if os.path.isdir(d) else []
    if not names:
        return None
    raw = os.path.join(work, "check-" + names[-1][:-3])
    with gzip.open(os.path.join(d, names[-1])) as f_in, open(raw, "wb") as f_out:
        shutil.copyfileobj(f_in, f_out)
    return raw


def rows(path, sql):
    c = sqlite3.connect(path)
    try:
        return [list(r) for r in c.execute(sql).fetchall()]
    finally:
        c.close()


def deletion(a):
    home, remote, bin_, files, fresh = setup(a)
    now = time.time()
    b = "lb-u-" + a.deleted
    five = now - 5 * DAY
    planted_b = [
        os.path.join(home, "lazyboy-backup/turso", b, "%s-%s.db.gz" % (b, stamp(five))),
        os.path.join(remote, "onedrive-backup/lazyboy-turso", b, "%s-%s.db.gz" % (b, stamp(five))),
    ]
    admin_old = [
        os.path.join(home, "lazyboy-backup/turso/lazyboy", "lazyboy-%s.db.gz" % stamp(five)),
        os.path.join(remote, "onedrive-backup/lazyboy-turso/lazyboy", "lazyboy-%s.db.gz" % stamp(five)),
    ]
    if fresh:
        for p in planted_b:
            gz_file(p, b"FRIENDB-only backup of " + b.encode(), five)
        for p in admin_old:
            gz_file(p, b"ADMIN-only older backup", five)
    before = {p: [digest(p), os.path.getmtime(p)] for p in admin_old}
    fake = tb.FakeTurso(files)
    try:
        rc, log, err = run_backup(a, home, remote, bin_, fake, {"FAKE_RCLONE_FAIL": a.fail} if a.fail else {})
        dumped = sorted(set(fake.dumped))
    finally:
        fake.close()
    lines = log.splitlines()
    prune_at = next((i for i, l in enumerate(lines) if " prune friends: " in l), None)
    first_dump = next((i for i, l in enumerate(lines) if " ok turso:" in l or "FAIL turso:" in l), None)
    out = {
        "rc": rc,
        "log": lines,
        "stderr": err,
        "dumped": dumped,
        "plantedBGone": [not os.path.exists(p) for p in planted_b],
        "pruneBeforeDump": prune_at is not None and (first_dump is None or prune_at < first_dump),
        "adminOldUntouched": all(os.path.exists(p) and [digest(p), os.path.getmtime(p)] == v for p, v in before.items()),
    }
    app = uploaded(remote, "lazyboy-turso/lazyboy-app", a.work)
    tele = uploaded(remote, "lazyboy-db", a.work)
    out["app"] = None if not app else {
        "users": rows(app, "SELECT uid, is_admin FROM users"),
        "user_tokens": rows(app, "SELECT uid FROM user_tokens"),
        "sync_state": rows(app, "SELECT uid FROM sync_state"),
        "events": rows(app, "SELECT DISTINCT uid FROM events"),
        "requests": rows(app, "SELECT count(*) FROM requests")[0][0],
        "friendBytes": b"FRIEND" in open(app, "rb").read(),
    }
    if tele:
        per = {}
        for t in ("api_log", "client_metrics", "cpu_meter"):
            per[t] = rows(tele, "SELECT DISTINCT user_id FROM %s" % t)
        per["lifecycle_log"] = rows(tele, "SELECT DISTINCT uid FROM lifecycle_log") if rows(tele, "SELECT count(*) FROM sqlite_master WHERE name = 'lifecycle_log'")[0][0] else []
        out["telemetry"] = {"userIds": per, "friendBytes": b"FRIEND" in open(tele, "rb").read()}
    else:
        out["telemetry"] = None
    names = []
    for base in (home, remote):
        for dp, ds, fs in os.walk(base):
            names += [os.path.join(dp, n) for n in ds + fs]
    out["filesNamingAFriend"] = sorted({os.path.basename(p) for p in names if "lb-u-" in p})
    print(json.dumps(out))


def clock(a):
    home, remote, bin_, files, fresh = setup(a)
    now = time.time()
    plants = {
        "local13": (os.path.join(home, "lazyboy-backup/turso/lazyboy"), 13),
        "local11": (os.path.join(home, "lazyboy-backup/turso/lazyboy"), 11),
        "remote59": (os.path.join(remote, "onedrive-backup/lazyboy-turso/lazyboy"), 59),
        "remote57": (os.path.join(remote, "onedrive-backup/lazyboy-turso/lazyboy"), 57),
    }
    paths = {}
    for k, (d, age) in plants.items():
        t = now - age * DAY
        p = os.path.join(d, "lazyboy-%s.db.gz" % stamp(t))
        gz_file(p, b"ADMIN-only backup aged %d days" % age, t)
        paths[k] = p
    fake = tb.FakeTurso(files)
    try:
        extra = {"LAZYBOY_BACKUP_NOW": str(now + a.days * DAY)} if a.days else {}
        rc, log, err = run_backup(a, home, remote, bin_, fake, extra)
    finally:
        fake.close()
    newest = sorted(n for n in os.listdir(os.path.join(home, "lazyboy-backup/turso/lazyboy")) if n.endswith(".db.gz"))
    print(json.dumps({"rc": rc, "log": log.splitlines(), "stderr": err, "kept": {k: os.path.exists(p) for k, p in paths.items()}, "localFiles": newest}))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["deletion", "clock"])
    ap.add_argument("--stores", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--admin-uid", required=True)
    ap.add_argument("--friend", action="append")
    ap.add_argument("--deleted")
    ap.add_argument("--fail")
    ap.add_argument("--days", type=float, default=0)
    a = ap.parse_args()
    (deletion if a.mode == "deletion" else clock)(a)
