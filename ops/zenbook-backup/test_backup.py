#!/usr/bin/env python3
"""Known answers for backup.py, the Zenbook's nightly backup, under Rem's ruling of Oct 15, 6:21 PM:
"Backups keep only Rem's rows" (/privacy: a departed friend's data is gone within five days,
backups included). Runs the real script as a subprocess against fixture files: a fake Turso (an
HTTP server answering /v2/pipeline and /dump from local SQLite files), a fake rclone
(fake_rclone.py, "OneDrive" a local directory) and a throwaway HOME. Touches no store, no
OneDrive and no network beyond 127.0.0.1.

    python3 -m unittest discover -s ops/zenbook-backup -p 'test_*.py'
"""
import gzip, http.server, json, os, shutil, sqlite3, stat, subprocess, sys, tempfile, threading, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "backup.py")
ADMIN = "remremremrem"
FRIEND = "ffffffffffff"
FRIEND_DB = "lb-u-" + FRIEND
TOKENS = {"lazyboy": "tok-core", "lazyboy-app": "tok-app", FRIEND_DB: "tok-friend"}


def make_db(path, statements):
    c = sqlite3.connect(path)
    c.executescript(";\n".join(statements) + ";")
    c.commit()
    c.close()


def rows(path, sql):
    c = sqlite3.connect(path)
    try:
        return c.execute(sql).fetchall()
    finally:
        c.close()


class FakeTurso:
    """/db/<name>/v2/pipeline and /db/<name>/dump over the fixture file of each database."""

    def __init__(self, files):
        self.files = files
        self.dumped = []
        self.down = set()
        fake = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _db(self):
                parts = self.path.split("/")  # "", "db", name, ...
                name = parts[2]
                if self.headers.get("Authorization") != "Bearer " + TOKENS.get(name, "?"):
                    self.send_error(401)
                    return None, None
                if name in fake.down:
                    self.send_error(503)
                    return None, None
                return name, "/" + "/".join(parts[3:])

            def do_GET(self):
                name, rest = self._db()
                if name is None:
                    return
                if rest != "/dump":
                    self.send_error(404)
                    return
                fake.dumped.append(name)
                c = sqlite3.connect(fake.files[name])
                body = ("\n".join(c.iterdump()) + "\n").encode()
                c.close()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self):
                name, rest = self._db()
                if name is None:
                    return
                req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                c = sqlite3.connect(fake.files[name])
                results = []
                for r in req["requests"]:
                    if r["type"] != "execute":
                        results.append({"type": "ok", "response": {"type": "close"}})
                        continue
                    try:
                        out = c.execute(r["stmt"]["sql"]).fetchall()
                        cell = lambda v: {"type": "null"} if v is None else {"type": "text", "value": str(v)}
                        results.append({"type": "ok", "response": {"type": "execute", "result": {"rows": [[cell(v) for v in row] for row in out]}}})
                    except sqlite3.Error as e:
                        results.append({"type": "error", "error": {"message": str(e)}})
                c.close()
                body = json.dumps({"results": results}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = "http://127.0.0.1:%d/db/" % self.server.server_address[1]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


APP_SCHEMA = [
    "CREATE TABLE users (uid TEXT PRIMARY KEY, account_id TEXT, spotify_id TEXT NOT NULL, db_name TEXT NOT NULL, status TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0)",
    "CREATE TABLE user_tokens (uid TEXT PRIMARY KEY, blob TEXT NOT NULL)",
    "CREATE TABLE sync_state (uid TEXT PRIMARY KEY, state TEXT NOT NULL)",
    "CREATE TABLE events (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, uid TEXT, code TEXT NOT NULL)",
    "CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT)",
    "CREATE TABLE requests (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL, uid TEXT UNIQUE)",
    "INSERT INTO users VALUES ('%s', 'rem-account', 'rem', 'lazyboy', 'active', 1)" % ADMIN,
    "INSERT INTO users VALUES ('%s', 'f-account', 'friend', '%s', 'active', 0)" % (FRIEND, FRIEND_DB),
    "INSERT INTO user_tokens VALUES ('%s', 'rem-cipher'), ('%s', 'FRIEND-cipher')" % (ADMIN, FRIEND),
    "INSERT INTO sync_state VALUES ('%s', 'active'), ('%s', 'active')" % (ADMIN, FRIEND),
    "INSERT INTO events (at, uid, code) VALUES (1, '%s', 'drift'), (2, '%s', 'owner-mismatch'), (3, NULL, 'grant-wide')" % (ADMIN, FRIEND),
    "INSERT INTO app_meta VALUES ('daily_at', '1'), ('health_red:5', 'isolation'), ('lock:daily', 'x'), "
    "('lock:spotify_refresh:%s', 'y'), ('deleted_telemetry:%s', '1'), ('token_copy:%s', 'copied:1')" % (FRIEND, FRIEND, ADMIN),
    "INSERT INTO requests VALUES ('r1', 'friend@example.test', 'FRIEND-name', 'claimed', '%s')" % FRIEND,
]
CORE_SCHEMA = [
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)",
    "CREATE TABLE plays (id INTEGER PRIMARY KEY, track_id TEXT NOT NULL, played_at TEXT NOT NULL)",
    "INSERT INTO meta VALUES ('owner_uid', '%s'), ('spotify_tokens', 'REM-plaintext-token'), ('me_id', 'rem')" % ADMIN,
    "INSERT INTO plays (track_id, played_at) VALUES ('rem-t1', '2026-10-15T10:00:00Z')",
]
TELEMETRY_SCHEMA = [
    "CREATE TABLE api_log (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, path TEXT NOT NULL, user_id TEXT)",
    "CREATE TABLE client_metrics (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, page TEXT, meta TEXT, user_id TEXT)",
    "CREATE TABLE usage_ledger (day TEXT NOT NULL, reader TEXT NOT NULL, calls INTEGER, PRIMARY KEY (day, reader))",
    "CREATE TABLE lifecycle_log (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, uid TEXT NOT NULL, action TEXT NOT NULL, by TEXT NOT NULL)",
    # The capacity meter's table (src/lib/db.ts TELEMETRY_SCHEMA): every invocation by day, route and user.
    "CREATE TABLE cpu_meter (day TEXT NOT NULL, route TEXT NOT NULL, user_id TEXT NOT NULL, invocations INTEGER, PRIMARY KEY (day, route, user_id))",
    "INSERT INTO cpu_meter VALUES ('2026-10-15', '/home', '%s', 4), ('2026-10-15', '/FRIEND-route', '%s', 9)" % (ADMIN, FRIEND),
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)",
    "INSERT INTO api_log (ts, path, user_id) VALUES (1, '/me/player', '%s'), (2, '/playlists/FRIEND-pl', '%s'), (3, '/old', NULL)" % (ADMIN, FRIEND),
    "INSERT INTO client_metrics (ts, page, meta, user_id) VALUES ('t', '/home', 'pv:a', '%s'), ('t', '/home', 'FRIEND-only', '%s'), ('t', '/home', 'pv:o', NULL)" % (ADMIN, FRIEND),
    "INSERT INTO usage_ledger VALUES ('2026-10-15', 'day_strip', 3)",
    "INSERT INTO lifecycle_log (at, uid, action, by) VALUES (1, '%s', 'removed', 'rem')" % FRIEND,
    "INSERT INTO meta VALUES ('spotify_tokens', 'REM-plaintext-token')",
]


class BackupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="lazyboy-backup-test-")
        self.home = os.path.join(self.tmp, "home")
        self.remote = os.path.join(self.tmp, "remote")
        self.bin = os.path.join(self.tmp, "bin")
        for d in (self.home, self.remote, self.bin, os.path.join(self.tmp, "turso")):
            os.makedirs(d)
        shutil.copy(os.path.join(HERE, "fake_rclone.py"), os.path.join(self.bin, "rclone"))
        os.chmod(os.path.join(self.bin, "rclone"), stat.S_IRWXU)
        self.files = {n: os.path.join(self.tmp, "turso", n + ".db") for n in ("lazyboy", "lazyboy-app", FRIEND_DB)}
        make_db(self.files["lazyboy"], CORE_SCHEMA)
        make_db(self.files["lazyboy-app"], APP_SCHEMA)
        make_db(self.files[FRIEND_DB], [
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)",
            "INSERT INTO meta VALUES ('owner_uid', '%s')" % FRIEND,
            "CREATE TABLE plays (id INTEGER PRIMARY KEY, track_id TEXT NOT NULL, played_at TEXT NOT NULL)",
            "INSERT INTO plays (track_id, played_at) VALUES ('FRIEND-t1', '2026-10-15')",
        ])
        tele = os.path.join(self.home, "lazyboy-sqld/data/dbs/default/data")
        os.makedirs(os.path.dirname(tele))
        make_db(tele, TELEMETRY_SCHEMA)
        backstop = os.path.join(self.home, "lazyboy-recorder/backstop.db")
        os.makedirs(os.path.dirname(backstop))
        make_db(backstop, ["CREATE TABLE plays (id INTEGER PRIMARY KEY, track_id TEXT)", "INSERT INTO plays (track_id) VALUES ('rem-t1')"])
        os.makedirs(os.path.join(self.home, "lazyboy-backup"))
        # A friend's backup copies from an older version of the job, fresh (an hour old), on the
        # Zenbook and on OneDrive: the prune deletes them at any age.
        self.old_local = os.path.join(self.home, "lazyboy-backup/turso", FRIEND_DB, FRIEND_DB + "-20261015-0907.db.gz")
        self.old_remote = os.path.join(self.remote, "onedrive-backup/lazyboy-turso", FRIEND_DB, FRIEND_DB + "-20261015-0907.db.gz")
        for p in (self.old_local, self.old_remote):
            os.makedirs(os.path.dirname(p))
            with gzip.open(p, "wb") as f:
                f.write(b"FRIEND-only")
            t = time.time() - 3600
            os.utime(p, (t, t))
        self.turso = FakeTurso(self.files)

    def tearDown(self):
        self.turso.close()
        shutil.rmtree(self.tmp)

    def backup_env(self):
        return {
            "HOME": self.home,
            "PATH": self.bin + os.pathsep + os.environ.get("PATH", ""),
            "FAKE_RCLONE_ROOT": self.remote,
            "LAZYBOY_TURSO_URL": self.turso.base + "lazyboy",
            "LAZYBOY_TURSO_RO_TOKEN": TOKENS["lazyboy"],
            "LAZYBOY_APP_URL": self.turso.base + "lazyboy-app",
            "LAZYBOY_APP_RO_TOKEN": TOKENS["lazyboy-app"],
        }

    def run_backup(self, **extra):
        env = {**self.backup_env(), **extra}
        p = subprocess.run([sys.executable, "-I", SCRIPT], env=env, capture_output=True, text=True, timeout=120)
        with open(os.path.join(self.home, "lazyboy-backup/backup.log")) as f:
            self.log = f.read()
        return p.returncode

    def uploaded(self, remote_dir):
        d = os.path.join(self.remote, "onedrive-backup", remote_dir)
        files = sorted(n for n in os.listdir(d) if n.endswith(".db.gz")) if os.path.isdir(d) else []
        if not files:
            return None
        raw = os.path.join(self.tmp, "check-" + files[-1][:-3])
        with gzip.open(os.path.join(d, files[-1])) as f_in, open(raw, "wb") as f_out:
            shutil.copyfileobj(f_in, f_out)
        return raw

    def all_names(self):
        out = []
        for base in (self.home, self.remote):
            for dirpath, dirs, files in os.walk(base):
                out += [os.path.join(dirpath, n) for n in dirs + files]
        return out

    # ── the rule ────────────────────────────────────────────────────────────────────────────
    def test_friends_copies_are_deleted_at_any_age_and_never_made(self):
        self.assertEqual(self.run_backup(), 0, self.log)
        self.assertFalse(os.path.exists(self.old_local))
        self.assertFalse(os.path.exists(self.old_remote))
        self.assertFalse(any(FRIEND_DB in p for p in self.all_names()), "a file still names the friend's database")
        # Only the admin's database and the app database were dumped; a friend's never.
        self.assertEqual(sorted(set(self.turso.dumped)), ["lazyboy", "lazyboy-app"])
        self.assertIn("check ok", self.log)

    def plant(self, path, age_days, body=b"x"):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with gzip.open(path, "wb") as f:
            f.write(body)
        t = time.time() - age_days * 86400
        os.utime(path, (t, t))
        return path

    def test_a_file_naming_a_friends_database_is_deleted_wherever_it_is_and_at_any_age(self):
        # Not only the per-database directories the job writes: any file or directory whose name
        # holds a friend's database, in every tree the deletion check reads, fresh or a year old.
        local = os.path.join(self.home, "lazyboy-backup")
        remote = os.path.join(self.remote, "onedrive-backup")
        planted = [
            self.plant(os.path.join(local, "turso", FRIEND_DB + "-20261016-0400.db.gz"), 0),
            self.plant(os.path.join(local, "snapshots", FRIEND_DB + "-20261016-0400.db.gz"), 0),
            self.plant(os.path.join(local, "turso/lazyboy", FRIEND_DB + "-copy.db.gz"), 0),
            self.plant(os.path.join(remote, "lazyboy-turso", FRIEND_DB + "-20261016-0400.db.gz"), 0),
            self.plant(os.path.join(remote, "lazyboy-db", FRIEND_DB, "zenbook-20251001-0840.db.gz"), 400),
            self.plant(os.path.join(remote, "lazyboy-backstop", FRIEND_DB + ".db.gz"), 0),
        ]
        self.assertEqual(self.run_backup(), 0, self.log)
        self.assertEqual([p for p in planted if os.path.exists(p)], [])
        self.assertFalse(any(FRIEND_DB in p for p in self.all_names()), "a file still names the friend's database")
        self.assertIn("check ok", self.log)

    def test_rems_copies_keep_their_60_days_and_a_renamed_admin_database_is_left_alone(self):
        # Rem's retention is untouched by the friends' prune: 60 days on OneDrive for every copy, 14
        # on the Zenbook; a directory under another name than lb-u- (Rem's database after a
        # restore renamed it) is never pruned as a friend's.
        remote = os.path.join(self.remote, "onedrive-backup")
        local = os.path.join(self.home, "lazyboy-backup")
        kept = [
            self.plant(os.path.join(remote, "lazyboy-turso/lazyboy/lazyboy-20260917-0840.db.gz"), 30),
            self.plant(os.path.join(remote, "lazyboy-turso/lazyboy/lazyboy-20260818-0840.db.gz"), 59),
            self.plant(os.path.join(remote, "lazyboy-turso/lazyboy-app/lazyboy-app-20260818-0840.db.gz"), 59),
            self.plant(os.path.join(remote, "lazyboy-turso/lazyboy-r1016/lazyboy-r1016-20261001-0840.db.gz"), 30),
            self.plant(os.path.join(remote, "lazyboy-db/zenbook-20260818-0840.db.gz"), 59),
            self.plant(os.path.join(remote, "lazyboy-backstop/backstop-20260818-0840.db.gz"), 59),
            self.plant(os.path.join(local, "turso/lazyboy/lazyboy-20261006-0840.db.gz"), 10),
        ]
        aged = [
            self.plant(os.path.join(remote, "lazyboy-turso/lazyboy/lazyboy-20260815-0840.db.gz"), 61),
            self.plant(os.path.join(remote, "lazyboy-db/zenbook-20260815-0840.db.gz"), 61),
            self.plant(os.path.join(local, "turso/lazyboy/lazyboy-20260926-0840.db.gz"), 20),
        ]
        self.assertEqual(self.run_backup(), 0, self.log)
        self.assertEqual([p for p in kept if not os.path.exists(p)], [])
        self.assertEqual([p for p in aged if os.path.exists(p)], [])

    def test_the_app_copy_keeps_only_the_admins_rows(self):
        self.assertEqual(self.run_backup(), 0, self.log)
        raw = self.uploaded("lazyboy-turso/lazyboy-app")
        self.assertIsNotNone(raw, self.log)
        self.assertEqual(rows(raw, "SELECT uid, is_admin FROM users"), [(ADMIN, 1)])
        self.assertEqual(rows(raw, "SELECT uid FROM user_tokens"), [(ADMIN,)])
        self.assertEqual(rows(raw, "SELECT uid FROM sync_state"), [(ADMIN,)])
        self.assertEqual(rows(raw, "SELECT uid, code FROM events"), [(ADMIN, "drift")])
        self.assertEqual(rows(raw, "SELECT count(*) FROM requests"), [(0,)])
        self.assertEqual(sorted(k for (k,) in rows(raw, "SELECT key FROM app_meta")), ["daily_at", "health_red:5", "token_copy:" + ADMIN])
        with open(raw, "rb") as f:
            self.assertNotIn(b"FRIEND", f.read(), "no free page keeps a friend's row")

    def test_the_telemetry_copy_keeps_the_admins_rows_and_untagged_ones(self):
        self.assertEqual(self.run_backup(), 0, self.log)
        raw = self.uploaded("lazyboy-db")
        self.assertIsNotNone(raw, self.log)
        self.assertEqual(rows(raw, "SELECT path, user_id FROM api_log ORDER BY id"), [("/me/player", ADMIN), ("/old", None)])
        self.assertEqual(rows(raw, "SELECT meta, user_id FROM client_metrics ORDER BY id"), [("pv:a", ADMIN), ("pv:o", None)])
        self.assertEqual(rows(raw, "SELECT count(*) FROM lifecycle_log"), [(0,)])
        self.assertEqual(rows(raw, "SELECT route, user_id FROM cpu_meter"), [("/home", ADMIN)])
        self.assertEqual(rows(raw, "SELECT count(*) FROM usage_ledger"), [(1,)])
        self.assertEqual(rows(raw, "SELECT count(*) FROM meta WHERE key LIKE 'spotify_tokens%'"), [(0,)])
        with open(raw, "rb") as f:
            self.assertNotIn(b"FRIEND", f.read())

    def test_the_admins_copy_is_whole_and_holds_no_token(self):
        self.assertEqual(self.run_backup(), 0, self.log)
        raw = self.uploaded("lazyboy-turso/lazyboy")
        self.assertEqual(rows(raw, "SELECT track_id FROM plays"), [("rem-t1",)])
        self.assertEqual(rows(raw, "SELECT value FROM meta WHERE key = 'owner_uid'"), [(ADMIN,)])
        self.assertEqual(rows(raw, "SELECT count(*) FROM meta WHERE key = 'spotify_tokens'"), [(0,)])
        self.assertIsNotNone(self.uploaded("lazyboy-backstop"))

    # ── the prune comes first, whatever fails after it ──────────────────────────────────────
    def test_the_prune_runs_when_every_dump_fails(self):
        self.turso.down.update({"lazyboy", "lazyboy-app"})
        self.assertEqual(self.run_backup(), 1, self.log)
        self.assertFalse(os.path.exists(self.old_local))
        self.assertFalse(os.path.exists(self.old_remote))
        self.assertIn("check ok", self.log)

    def test_the_prune_has_run_before_the_job_dies_later_in_the_night(self):
        # A missing variable kills the run outside every per-copy guard (a KeyError while the
        # copies are being set up): the friends' copies were already gone.
        p = subprocess.run(
            [sys.executable, "-I", SCRIPT],
            env={k: v for k, v in self.backup_env().items() if k != "LAZYBOY_TURSO_URL"},
            capture_output=True, text=True, timeout=120,
        )
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("KeyError", p.stderr)
        self.assertFalse(os.path.exists(self.old_local))
        self.assertFalse(os.path.exists(self.old_remote))

    def test_with_the_app_database_down_friends_are_still_pruned_and_nothing_unfiltered_ships(self):
        self.turso.down.add("lazyboy-app")
        self.assertEqual(self.run_backup(), 1, self.log)
        self.assertFalse(os.path.exists(self.old_local))
        self.assertFalse(os.path.exists(self.old_remote))
        # The admin is unknown, so nothing that needs him (his database, the filtered copies) ships.
        for d in ("lazyboy-turso/lazyboy", "lazyboy-turso/lazyboy-app", "lazyboy-db"):
            self.assertIsNone(self.uploaded(d), d)
        self.assertIsNotNone(self.uploaded("lazyboy-backstop"))
        backups = os.path.join(self.home, "lazyboy-backup")
        self.assertFalse(any(p.endswith(".db") for p in self.all_names() if p.startswith(backups)), "an unstripped raw copy was left behind")

    # ── fail closed ─────────────────────────────────────────────────────────────────────────
    def test_a_database_whose_owner_is_not_the_admin_is_not_shipped(self):
        c = sqlite3.connect(self.files["lazyboy"])
        c.execute("UPDATE meta SET value = ? WHERE key = 'owner_uid'", (FRIEND,))
        c.commit()
        c.close()
        self.assertEqual(self.run_backup(), 1, self.log)
        self.assertIsNone(self.uploaded("lazyboy-turso/lazyboy"))
        self.assertIn("owner_uid", self.log)

    def test_an_unreviewed_app_table_fails_the_app_copy(self):
        c = sqlite3.connect(self.files["lazyboy-app"])
        c.execute("CREATE TABLE invites_v2 (email TEXT)")
        c.execute("INSERT INTO invites_v2 VALUES ('friend@example.test')")
        c.commit()
        c.close()
        self.assertEqual(self.run_backup(), 1, self.log)
        self.assertIsNone(self.uploaded("lazyboy-turso/lazyboy-app"))
        self.assertIn("invites_v2", self.log)

    def test_telemetry_without_user_id_is_not_shipped(self):
        tele = os.path.join(self.home, "lazyboy-sqld/data/dbs/default/data")
        os.remove(tele)
        make_db(tele, [s.replace(", user_id TEXT", "") for s in TELEMETRY_SCHEMA[:2]])
        self.assertEqual(self.run_backup(), 1, self.log)
        self.assertIsNone(self.uploaded("lazyboy-db"))

    # ── the clock: a night days ahead (the rehearsal's daily cycle, tests/rehearsal/) ──────────
    def test_the_age_prunes_read_the_clock_they_are_given(self):
        now = time.time()
        local = os.path.join(self.home, "lazyboy-backup/turso/lazyboy")
        remote = os.path.join(self.remote, "onedrive-backup/lazyboy-turso/lazyboy")
        made = {}
        for where, d, age in (("local", local, 13), ("local", local, 11), ("remote", remote, 59), ("remote", remote, 57)):
            t = now - age * 86400
            p = os.path.join(d, "lazyboy-%s.db.gz" % time.strftime("%Y%m%d-%H%M", time.gmtime(t)))
            os.makedirs(d, exist_ok=True)
            with gzip.open(p, "wb") as f:
                f.write(b"old")
            os.utime(p, (t, t))
            made[(where, age)] = p
        # Two days on, the 13-day local copy passes the 14-day limit and the 59-day remote one the
        # 60-day limit; the 11- and 57-day ones do not.
        self.assertEqual(self.run_backup(LAZYBOY_BACKUP_NOW=str(now + 2 * 86400)), 0, self.log)
        self.assertEqual({k: os.path.exists(p) for k, p in made.items()},
                         {("local", 13): False, ("local", 11): True, ("remote", 59): False, ("remote", 57): True})

    def test_the_check_fails_when_a_friends_copy_cannot_be_deleted(self):
        self.assertEqual(self.run_backup(FAKE_RCLONE_FAIL="purge"), 1, self.log)
        self.assertTrue(os.path.exists(self.old_remote))
        self.assertIn("FAIL check", self.log)


if __name__ == "__main__":
    unittest.main()
