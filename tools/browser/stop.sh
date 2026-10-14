#!/usr/bin/env bash
# Stops what start.sh started: by its recorded process ids, and whatever still listens on its two
# ports (:3100, :4400 — only ever used by these checks, never by the dev servers).
R="$(cd "$(dirname "$0")" && pwd)/run"
for f in "$R/server.pid" "$R/serve.pid"; do
  [[ -f "$f" ]] && kill "$(cat "$f")" 2>/dev/null
  rm -f "$f"
done
for port in 3100 4400; do
  for pid in $(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
    kill "$pid" 2>/dev/null
  done
done
echo stopped
