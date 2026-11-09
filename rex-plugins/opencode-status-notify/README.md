# OpenCode OSC 7501 notifications for Rex

This watcher listens for Rex's `terminal.program_status_changed` events and
shows a macOS notification when an OpenCode session transitions into the OSC
7501 `blocked` state. It ignores root summary records so one waiting session
doesn't produce duplicate notifications. Working, idle, and completed statuses
do not notify.

Rex already parses OSC 7501 and exposes the resulting records as Lua events, so
this uses the supported Rex event API rather than parsing terminal output.

## Install

From a Rex terminal (so `rex` is on `PATH`):

```sh
./rex-plugins/opencode-status-notify/install.sh
```

The installer creates a per-user macOS LaunchAgent that starts the watcher at
login and keeps it running across exits. Notifications are produced by
`/usr/bin/osascript`; macOS may ask you to allow notifications for its host
process the first time.

To check it:

```sh
launchctl print gui/$(id -u)/com.cuppari.rex.program-status-notify
```

The LaunchAgent logs are in `~/Library/Logs/RexProgramStatusNotify/`.

## Uninstall

```sh
./rex-plugins/opencode-status-notify/uninstall.sh
```

This removes only the LaunchAgent installed by this watcher. The source stays
in this repository.

## Compatibility

OpenCode must emit OSC 7501 `blocked` reports with `app=opencode`. The watcher
does not infer waiting states from terminal text or OpenCode's server API.

OpenCode v2.0.32 does not emit these reports; the reporter is present in the
current upstream development source but was not in the v2.0.32 release. The
watcher is ready for an OpenCode release that includes the reporter.
