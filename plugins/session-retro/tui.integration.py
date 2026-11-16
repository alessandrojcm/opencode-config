#!/usr/bin/env python3
"""Exercise /retro pending in a fresh OpenCode TUI, without the user's data."""

import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import tempfile
import termios
import time
from pathlib import Path


def main():
    plugin = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory(prefix="session-retro-tui-") as tmp:
        root = Path(tmp)
        config = root / "config" / "opencode"
        config.mkdir(parents=True)
        project = root / "project"
        project.mkdir()
        (config / "opencode.json").write_text(json.dumps({"plugins": [str(plugin)]}))
        (config / "cli.json").write_text(json.dumps({"highlights": False}))

        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(project)
            os.environ.update(
                TERM="xterm-256color",
                COLUMNS="100",
                LINES="30",
                XDG_CONFIG_HOME=str(root / "config"),
                XDG_DATA_HOME=str(root / "data"),
                XDG_CACHE_HOME=str(root / "cache"),
                XDG_STATE_HOME=str(root / "state"),
            )
            os.execvp("opencode2", ["opencode2", "--standalone"])

        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
        output = bytearray()

        def text():
            data = re.sub(rb"\x1b\][^\x07]*(?:\x07|\x1b\\)", b"", output)
            data = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", data)
            return re.sub(rb"\s+", b"", data)

        def wait_for(markers, timeout):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if all(marker in text() for marker in markers):
                    return
                ready, _, _ = select.select([fd], [], [], min(0.2, deadline - time.monotonic()))
                if ready:
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    output.extend(chunk)
            raise AssertionError(f"Missing {markers!r}; terminal output: {text()[-4000:]!r}")

        try:
            wait_for([b"Askanything"], 45)
            for _ in range(2):
                output.clear()
                os.write(fd, b"/retro")
                wait_for([b"Analyzethissession,orusepending/settings/skip/later."], 30)
                output.clear()
                os.write(fd, b" pending")
                wait_for([b"pending"], 10)
                os.write(fd, b"\r")
                wait_for([b"Pendingretros", b"escback", b"Nosessionswithapendingretro."], 25)
                if b"crashedinroute" in text():
                    raise AssertionError("Session retro route crashed")
                output.clear()
                os.write(fd, b"\x1b")
                wait_for([b"Askanything"], 10)
            print("PASS: /retro pending renders twice and Escape returns home")
        finally:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.close(fd)


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, OSError) as error:
        sys.exit(str(error))
