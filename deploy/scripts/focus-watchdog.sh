#!/usr/bin/env bash
# Keeps the game window focused, undecorated and pinned at 0,0.
#
# Why this exists: WinMain.cpp releases the cursor clip and calls
# TheAudio->loseFocus() on WM_ACTIVATE/WA_INACTIVE. If the Wine window ever
# loses X input focus, the stream keeps rendering but input and audio go dead
# in a way that looks exactly like a network problem. This loop makes that
# state unreachable.
set -uo pipefail

log() { printf '[focus] %s\n' "$*" >&2; }

sleep 5
last=""
while true; do
    # Wine top-level windows carry WM_CLASS matching the executable.
    wid=$(xdotool search --onlyvisible --name "Command and Conquer" 2>/dev/null | head -1)
    if [[ -z "${wid}" ]]; then
        # Fall back to any override-free window owned by wine.
        wid=$(xdotool search --onlyvisible --class "." 2>/dev/null | tail -1)
    fi

    if [[ -n "${wid}" ]]; then
        if [[ "${wid}" != "${last}" ]]; then
            log "tracking window ${wid}"
            last="${wid}"
        fi
        # Undecorate + position + size, then focus. All are cheap no-ops once
        # they have taken effect.
        wmctrl -i -r "${wid}" -b remove,maximized_vert,maximized_horz 2>/dev/null || true
        xdotool windowmove "${wid}" 0 0 2>/dev/null || true
        xdotool windowsize "${wid}" "${SCREEN_WIDTH}" "${SCREEN_HEIGHT}" 2>/dev/null || true

        active=$(xdotool getactivewindow 2>/dev/null || echo "")
        if [[ "${active}" != "${wid}" ]]; then
            xdotool windowactivate --sync "${wid}" 2>/dev/null || true
            xdotool windowfocus "${wid}" 2>/dev/null || true
        fi
        # Publish the window id so the streamer can capture it directly if we
        # ever want per-window capture instead of root capture.
        echo "${wid}" > /run/cnc/game-window-id
    fi
    sleep 2
done
