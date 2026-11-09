#!/bin/sh
set -eu

label='com.cuppari.rex.program-status-notify'
plist="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"

if [ -f "$plist" ]; then
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl bootout "$domain" "$plist"
  fi
  rm "$plist"
  echo "Removed $label"
else
  echo "$label is not installed"
fi
