# The Zenbook's store services: sqld and the meter

`sqld` (127.0.0.1:8092) and the meter (`meter-proxy.mjs`, 127.0.0.1:8090) are the only services the
Tailscale Funnel exposes: `https://ubuntu.tail026729.ts.net` / → `http://127.0.0.1:8090` (root's
`tailscaled`, `tailscale serve status`). Since 2026-10-16 09:43 UTC they run as **system units under
their own account, `lbsvc`**, which cannot read anything of the `remtbkv` account (the Zenbook's
login user; `ssh ubuntu` is only the host alias). Multi-user PLAN §12.4 and §13.2, decision 27,
review-security R10: a flaw in the Funnel-facing meter or sqld must not hand over the backups, their
read-only Turso token, the rclone (OneDrive) config or the recorder's Spotify grant.

## Layout

| path | owner, mode | what |
|---|---|---|
| `lbsvc` (uid 999, gid 986) | system user, `/usr/sbin/nologin`, home `/nonexistent` | not in `sudo`, not in group `remtbkv` |
| `/opt/lazyboy-store/bin/sqld` | root:root 0755 | the binary the unit runs (copy of `~/lazyboy-sqld/bin/sqld`, 0.24.32) |
| `/opt/lazyboy-store/meter-proxy.mjs` | root:root 0644 | the meter the unit runs (this directory's file) |
| `/opt/lazyboy-store/jwt-public.pem` | root:root 0644 | sqld's JWT verification key |
| `/srv/lazyboy-sqld/` | lbsvc:remtbkv 2770 | `data/` (sqld's `--db-path`), `querylog/`, `FENCE_CORE` |
| files under it | lbsvc:remtbkv 0660 | the units run with `UMask=0007`; the setgid bit keeps every new file in group `remtbkv` |
| `/etc/systemd/system/lazyboy-{sqld,meter}.service` | root 0644 | this directory's unit files, enabled for `multi-user.target` |

Group `remtbkv` on the data is deliberate: the backup job, `readmeter.sh`, `meter-report.py` and lane
1909 keep reading (and may write) sqld's files from the running `remtbkv` user manager, which a new
group membership would only reach after it restarted. Trust runs one way: `remtbkv` (who has sudo
anyway) reaches lbsvc's data; lbsvc reaches nothing of `remtbkv`'s, because `/home/remtbkv` is 0750
and lbsvc is in neither group.

`~/lazyboy-sqld/data`, `~/lazyboy-sqld/querylog` and `~/lazyboy-sqld/FENCE_CORE` are symlinks into
`/srv/lazyboy-sqld`, so every older path (backup.py's `ZENBOOK_SRC`, readmeter.sh, the docs) still
resolves. The fence: `touch ~/lazyboy-sqld/FENCE_CORE` turns it on through the link, but **`rm` the
real file, `/srv/lazyboy-sqld/FENCE_CORE`**: removing the link leaves the fence on. The meter gets
the path from `FENCE_FILE` in its unit. `jwt-private.pem` and `jwt-token.txt` stay in `remtbkv`'s
`~/lazyboy-sqld` (0600); the services do not need them.

## The sandbox, and the WSL hole it closes

The Zenbook's Linux is WSL. `/mnt/c` is the Windows C: drive, mounted `uid=1000` with every file
0777, and the WSL interop sockets in `/run/WSL` are 0777, so **any** Linux account can read the
Windows profile and run Windows programs as Rem's Windows user (which reaches
`\\wsl.localhost\…\home\remtbkv` as `remtbkv`). Home-directory modes cannot close that; measured on
2026-10-16 with `sudo -u lbsvc`: `/mnt/c/Users/remtb` readable, `cmd.exe /c ver` runs. The units
therefore run sandboxed: `ProtectHome=yes`, `ProtectSystem=strict` with only `/srv/lazyboy-sqld`
writable, `InaccessiblePaths=-/mnt -/run/WSL -/init`, `NoExecPaths=/srv/lazyboy-sqld`,
`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` (no vsock), `NoNewPrivileges`, private `/tmp`
and devices. A shell won through either service inherits the sandbox. Changing the WSL mount or
interop settings host-wide is a separate decision (DiveLoop's lanes use interop).

## Operating it

```bash
sudo systemctl status lazyboy-sqld lazyboy-meter          # not `systemctl --user` any more
journalctl -u lazyboy-meter -n 20
# deploy a new meter (test first: node --test ops/zenbook-meter/meter-proxy.test.mjs)
scp ops/zenbook-meter/meter-proxy.mjs ubuntu:lazyboy-sqld/meter-proxy.mjs
ssh ubuntu 'sudo install -o root -g root -m 0644 ~/lazyboy-sqld/meter-proxy.mjs /opt/lazyboy-store/meter-proxy.mjs && sudo systemctl restart lazyboy-meter'
```

The probe that proves the separation (2026-10-16, every line `denied` as plain lbsvc and inside the
sandbox; `/mnt/c` and interop refused only inside it): `test -r` as lbsvc on `/home/remtbkv`,
`~/lazyboy-backup` and its `env`, `~/.config/rclone/rclone.conf`, `~/lazyboy-recorder` and its
`tokens.json`, `~/.ssh`, `~/lazyboy-sqld/jwt-private.pem`. Run it in the sandbox with a transient
unit carrying the service's properties: `sudo systemd-run --wait --pipe --collect -p User=lbsvc
-p ProtectHome=yes … <probe>`.

## Rollback

`~/lazyboy-sqld/rollback-mu10.sh` on the Zenbook (this directory's `rollback-mu10.sh`): stops and
removes the system units, moves `data`, `querylog` and `FENCE_CORE` back into `~/lazyboy-sqld`
(replacing the links) owned by `remtbkv`, renames the old user units
`~/.config/systemd/user/lazyboy-{sqld,meter}.service.pre-mu10` back, and starts them with
`systemctl --user`. Same ports, so the Funnel needs nothing. It leaves the `lbsvc` account,
`/opt/lazyboy-store` and an empty `/srv/lazyboy-sqld` behind, inert.

## Other files here

`meter-proxy.mjs` (+ its test), `meter-report.py` (rolls up the query log), `readmeter.sh` +
`lazyboy-readmeter.{service,timer}` (sqld's cumulative counters every 15 minutes; still a
`remtbkv` user unit, reading `stats.json` through the `data` link). docs/READ_QUOTA.md has the
meter's numbers, docs/quota-forensic/BRIDGE.md the Zenbook's history.
