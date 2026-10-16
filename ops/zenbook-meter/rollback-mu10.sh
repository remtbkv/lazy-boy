#!/bin/bash
# Undo lane 1945_10 (decision 27): sqld and the meter back to remtbkv's systemd user units with their data in
# ~/lazyboy-sqld. Safe on a half-applied switch: each step checks what is there first. Leaves the lbsvc
# account, /opt/lazyboy-store and the emptied /srv/lazyboy-sqld behind (inert).
set -uo pipefail
H=$HOME/lazyboy-sqld
S=/srv/lazyboy-sqld
U=$HOME/.config/systemd/user
G=$(id -gn)

sudo systemctl disable --now lazyboy-meter.service lazyboy-sqld.service 2>/dev/null
sudo rm -f /etc/systemd/system/lazyboy-sqld.service /etc/systemd/system/lazyboy-meter.service
sudo systemctl daemon-reload

for x in data querylog FENCE_CORE; do
  [ -L "$H/$x" ] && rm "$H/$x"
  if [ -e "$S/$x" ] && [ ! -e "$H/$x" ]; then
    sudo mv -n "$S/$x" "$H/$x"
    sudo chown -R "$(id -un):$G" "$H/$x"
  fi
done

for u in lazyboy-sqld lazyboy-meter; do
  [ -f "$U/$u.service.pre-mu10" ] && [ ! -e "$U/$u.service" ] && mv -n "$U/$u.service.pre-mu10" "$U/$u.service"
done
systemctl --user daemon-reload
systemctl --user enable --now lazyboy-sqld.service lazyboy-meter.service
sleep 2
systemctl --user is-active lazyboy-sqld.service lazyboy-meter.service
ss -ltnp | grep -E '127.0.0.1:(8090|8092)\b'
