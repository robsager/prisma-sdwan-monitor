#!/bin/bash
# Prisma SD-WAN Monitor for macOS (and Linux): double-click in Finder, or run ./start.command.
# The first run creates a Python environment in .venv and installs the requirements (~1 min).
# Stop the server with Ctrl+C or by closing this window.
cd "$(dirname "$0")" || exit 1

fail() { echo "$1"; read -r -p "Press Return to close."; exit 1; }

if [ ! -x .venv/bin/python ]; then
  for c in python3.14 python3.13 python3.12 python3.11 python3.10 python3; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then
      PY="$c"; break
    fi
  done
  [ -n "$PY" ] || fail "Python 3.10 or newer is required. Install it from https://www.python.org/downloads/ and try again."
  echo "Creating the Python environment (.venv) with $PY..."
  "$PY" -m venv .venv || fail "Couldn't create .venv."
fi

# Install or update the requirements when requirements.txt has changed (e.g. after git pull).
if ! cmp -s requirements.txt .venv/installed-requirements.txt; then
  echo "Installing requirements..."
  .venv/bin/python -m pip install -q --upgrade pip
  .venv/bin/python -m pip install -q -r requirements.txt || fail "Installing the requirements failed."
  cp requirements.txt .venv/installed-requirements.txt
fi

.venv/bin/python app.py --open
code=$?
# Exit code 2: an older version is still running (app.py says how to stop it).
[ "$code" -eq 2 ] && read -r -p "Press Return to close."
exit "$code"
