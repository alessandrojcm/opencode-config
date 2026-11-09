#!/bin/sh
set -eu

label='com.cuppari.rex.program-status-notify'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
watcher="$script_dir/program-status-notify.lua"
rex_bin=$(command -v rex || true)

if [ -z "$rex_bin" ]; then
  echo 'Could not find rex on PATH. Run this from a Rex terminal or add Rex to PATH.' >&2
  exit 1
fi

plist_dir="$HOME/Library/LaunchAgents"
log_dir="$HOME/Library/Logs/RexProgramStatusNotify"
plist="$plist_dir/$label.plist"
mkdir -p "$plist_dir" "$log_dir"

python3 - "$plist" "$label" "$rex_bin" "$watcher" "$log_dir" <<'PY'
import os
import plistlib
import sys

path, label, rex_bin, watcher, log_dir = sys.argv[1:]
home = os.path.expanduser("~")
program = {
    "Label": label,
    "ProgramArguments": [rex_bin, "do", watcher, "--all"],
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 10,
    "ProcessType": "Background",
    "EnvironmentVariables": {
        "HOME": home,
        "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    },
    "StandardOutPath": os.path.join(log_dir, "stdout.log"),
    "StandardErrorPath": os.path.join(log_dir, "stderr.log"),
}
with open(path, "wb") as output:
    plistlib.dump(program, output, sort_keys=False)
PY

domain="gui/$(id -u)"
if launchctl print "$domain/$label" >/dev/null 2>&1; then
  launchctl bootout "$domain" "$plist"
fi
launchctl bootstrap "$domain" "$plist"

echo "Installed and started $label"
echo "Logs: $log_dir"
