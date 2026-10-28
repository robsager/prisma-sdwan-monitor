"""Prisma SD-WAN Monitor.

Run:  python app.py [--open]   then open http://127.0.0.1:5050 (PORT changes it; avoid 5000 on macOS,
AirPlay Receiver uses it). Binds to localhost only; credentials leave this machine only for the
Palo Alto Networks auth and API endpoints.
"""
import json
import socket
import sys
import threading
import urllib.error
import urllib.request
import webbrowser

from waitress import serve

from manager import config
from manager.web import create_app


def running_version(url):
    """The version of a Monitor already running at url, or None if it isn't one."""
    try:
        with urllib.request.urlopen(f"{url}/api/version", timeout=5) as resp:
            return str(json.load(resp).get("version") or "unknown")
    except urllib.error.HTTPError as e:
        return "before 1.0" if e.code == 404 else None
    except (OSError, ValueError):
        return None


def main(argv):
    url = f"http://127.0.0.1:{config.PORT}"
    with socket.socket() as s:
        in_use = s.connect_ex(("127.0.0.1", config.PORT)) == 0
    if in_use:
        running = running_version(url)
        if running is not None and running != config.VERSION:
            # Upgrading while the old server still runs: opening it would show the old version.
            # Exit code 2 makes start.command / start.bat wait so this can be read.
            print(f"Prisma SD-WAN Monitor {running} is still running at {url}, but this folder has {config.VERSION}.\n"
                  "Stop the running one (close its window, or on Windows end its python.exe in Task Manager),\n"
                  "then start again.")
            return 2
        print(f"Port {config.PORT} is already in use; if Prisma SD-WAN Monitor is running, it's at {url}")
        if "--open" in argv:
            webbrowser.open(url)
        return 0
    if "--open" in argv:
        threading.Timer(1.0, webbrowser.open, [url]).start()
    print(f"Prisma SD-WAN Monitor {config.VERSION} running at {url} (Ctrl+C to stop)", flush=True)
    # Several slow requests run at once (Overview builds, device polls, later Site details), so
    # more threads than Waitress's default 4. Each open tab also holds one for the ION Connectivity
    # Monitor's waiting request (up to MONITOR_WAIT_S).
    app = create_app()
    try:
        serve(app, host="127.0.0.1", port=config.PORT, threads=24)
    finally:  # Ctrl+C: save open sites' series, so a restart resumes from the latest minutes
        app.config["registry"].close_all()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
