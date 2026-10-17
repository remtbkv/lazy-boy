#!/usr/bin/env python3
"""A stand-in for rclone in test_backup.py: `<remote>:<path>` is the directory
$FAKE_RCLONE_ROOT/<remote>/<path>. It implements only what backup.py runs, with rclone's exit
code 3 and "directory not found" for a missing directory. $FAKE_RCLONE_FAIL names subcommands
that fail (exit 1); every call is appended to $FAKE_RCLONE_ROOT/calls.log."""
import os, shutil, sys, time

root = os.environ["FAKE_RCLONE_ROOT"]
args = sys.argv[1:]
with open(os.path.join(root, "calls.log"), "a") as f:
    f.write(" ".join(args) + "\n")
cmd = args[0]
if cmd in os.environ.get("FAKE_RCLONE_FAIL", "").split(","):
    sys.stderr.write("fake rclone: %s refused\n" % cmd)
    sys.exit(1)


def local(spec):
    remote, _, path = spec.partition(":")
    return os.path.join(root, remote, path)


def missing(p):
    sys.stderr.write("ERROR : error listing: directory not found: %s\n" % p)
    sys.exit(3)


if cmd == "copy":
    src, dst = args[1], local(args[2])
    os.makedirs(dst, exist_ok=True)
    shutil.copy2(src, dst)
elif cmd == "delete":
    d = local(args[1])
    days = int(args[args.index("--min-age") + 1].rstrip("d"))
    if not os.path.isdir(d):
        missing(d)
    # backup.py's clock (LAZYBOY_BACKUP_NOW), so a night run days ahead ages OneDrive's copies too.
    now = float(os.environ.get("LAZYBOY_BACKUP_NOW") or time.time())
    for dirpath, _, files in os.walk(d):
        for n in files:
            p = os.path.join(dirpath, n)
            if now - os.path.getmtime(p) >= days * 86400:
                os.remove(p)
elif cmd == "deletefile":
    p = local(args[1])
    if not os.path.isfile(p):
        sys.stderr.write("ERROR : %s: object not found\n" % p)
        sys.exit(4)
    os.remove(p)
elif cmd == "purge":
    d = local(args[1])
    if not os.path.isdir(d):
        missing(d)
    shutil.rmtree(d)
elif cmd == "lsf":
    d = local(args[-1])
    if not os.path.isdir(d):
        missing(d)
    if "--dirs-only" in args:
        for n in sorted(os.listdir(d)):
            if os.path.isdir(os.path.join(d, n)):
                print(n + "/")
    elif "-R" in args:
        for dirpath, dirs, files in os.walk(d):
            rel = os.path.relpath(dirpath, d)
            for n in sorted(dirs):
                print(os.path.normpath(os.path.join(rel, n)) + "/")
            for n in sorted(files):
                print(os.path.normpath(os.path.join(rel, n)))
else:
    sys.stderr.write("fake rclone: unsupported %s\n" % cmd)
    sys.exit(2)
