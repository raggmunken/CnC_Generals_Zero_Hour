#!/usr/bin/env bash
# Healthy means: X is up, and the signalling/HTTP endpoint answers.
set -uo pipefail
xdpyinfo -display "${DISPLAY:-:0}" >/dev/null 2>&1 || exit 1
exec curl -fsS --max-time 3 "http://127.0.0.1:${STREAM_PORT:-8080}/healthz" >/dev/null
