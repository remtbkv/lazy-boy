# The Zenbook's nightly backup

`backup.py` is `~/lazyboy-backup/backup.py` on the Zenbook (`ssh ubuntu`), run by the user unit
`lazyboy-backup.service` from `lazyboy-backup.timer` at 04:40 America/New_York, with its environment
from `~/lazyboy-backup/env` (mode 600) through the drop-in `lazyboy-backup.service.d/env.conf`. The
first commit of this directory is the file as lane 1904 deployed it on Oct 16, 2026 (sha256
`cf8f581c…`); the next is the change below. Known answers: `test_backup.py` (a fake Turso over local
SQLite files, `fake_rclone.py` for OneDrive), part of `npm test`:

```bash
python3 -m unittest discover -s ops/zenbook-backup -p 'test_*.py'
```

## The rule it keeps

Rem, Oct 15, 6:21 PM: "Backups keep only Rem's rows" (RULINGS.md), because `/privacy` says a
friend's data is not backed up and a departed friend's is gone within five days. So, every night:

1. **The prune runs first and unconditionally.** Every backup of a database that is not the admin's
   (every file or directory whose name holds `lb-u-`: a friend's database has that name by
   construction, the admin's never) is deleted at any age, anywhere in `~/lazyboy-backup/` and in
   the three remotes (`onedrive-backup:lazyboy-turso`, `:lazyboy-db`, `:lazyboy-backstop`), the
   paths step 3 checks, before any store is read, so it runs even on a night nothing answers. Any
   other name (Rem's database under a name a restore gave it) is left alone.
2. **Copies of Rem's rows only.** The admin's database (named by his `users` row, checked by its
   `meta.owner_uid`), `lazyboy-app` filtered to his rows (unknown tables fail the copy), the
   Zenbook's telemetry file filtered to his uid and NULL (rows from before Phase 1 tagged them), and
   the backstop recorder's file. A friend's database is never dumped. Token and lock rows are
   stripped and the file VACUUMed before it is compressed.
3. **The deletion check.** No file here or on OneDrive names a friend's database; the log says
   `check ok: …` or `FAIL check: …`, and the unit fails on the second.

Retention: 60 days for every copy (14 days on the Zenbook). PLAN §12.4's four days applied to copies
holding friends' rows; none does now, so the telemetry copies keep Rem's 60 rather than cutting his
own history of diagnostics to four.

## Installing it (lane 24, with Phase 4a, before `SIGNUPS=invite`)

Under DiveLoop's change lock (`~/diveloop-data/CHANGE_LOCK`, RULES 16):

```bash
ssh ubuntu 'cp -p ~/lazyboy-backup/backup.py ~/lazyboy-backup/backup.py.pre-4a'
scp ops/zenbook-backup/backup.py ubuntu:lazyboy-backup/backup.py
ssh ubuntu 'chmod 700 ~/lazyboy-backup/backup.py'
```

Two new variables in `~/lazyboy-backup/env`: `LAZYBOY_APP_URL` (`https://lazyboy-app-<org>.turso.io`)
and `LAZYBOY_APP_RO_TOKEN`, a read-only token for `lazyboy-app` minted inside the pipe that writes it,
never printed (`turso db tokens create lazyboy-app --read-only`). Then one run by hand,
`ssh ubuntu systemctl --user start lazyboy-backup.service`, and `tail -10 ~/lazyboy-backup/backup.log` (one line per step, ten in all):
`prune friends`, `ok turso:lazyboy`, `ok turso:lazyboy-app … users=1 …`, `ok zenbook`, `ok backstop`,
`check ok`. Rollback: `cp -p ~/lazyboy-backup/backup.py.pre-4a ~/lazyboy-backup/backup.py` (it backs up
no friend only while no friend exists).
