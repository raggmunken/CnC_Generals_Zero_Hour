#!/usr/bin/env bash
# Keeps the game window focused, undecorated and pinned at 0,0.
#
# Why this exists: WinMain.cpp releases the cursor clip and calls
# TheAudio->loseFocus() on WM_ACTIVATE/WA_INACTIVE, and the game's keyboard is
# DirectInput acquired DISCL_FOREGROUND. If the Wine window ever loses X input
# focus, the stream keeps rendering while input and audio go dead -- which
# looks exactly like a network problem. This loop makes that state unreachable.
set -uo pipefail

log() { printf '[focus] %s\n' "$*" >&2; }

# Area of a window in pixels, or 0 if it cannot be measured.
win_area() {
    local wid="$1" geom w h
    geom=$(xdotool getwindowgeometry --shell "${wid}" 2>/dev/null) || { echo 0; return; }
    w=$(sed -n 's/^WIDTH=//p'  <<<"${geom}")
    h=$(sed -n 's/^HEIGHT=//p' <<<"${geom}")
    [[ -n "${w}" && -n "${h}" ]] || { echo 0; return; }
    echo $(( w * h ))
}

# Find the game window. Three strategies, most specific first:
#   1. its title, which Wine takes from the game's own window caption
#   2. its WM_CLASS, which Wine derives from the executable name
#   3. the largest visible window that is not openbox's own
find_game_window() {
    local wid
    wid=$(xdotool search --onlyvisible --name 'Command *(and|&) *Conquer' 2>/dev/null | head -1)
    [[ -n "${wid}" ]] && { echo "${wid}"; return; }

    wid=$(xdotool search --onlyvisible --class 'generals|game\.dat|zerohour|wine' 2>/dev/null | head -1)
    [[ -n "${wid}" ]] && { echo "${wid}"; return; }

    local best="" best_area=0 area
    while read -r candidate; do
        [[ -n "${candidate}" ]] || continue
        area=$(win_area "${candidate}")
        # Ignore anything much smaller than the screen: openbox helper windows,
        # Wine's own tray and splash surfaces.
        (( area > best_area )) && { best_area=${area}; best=${candidate}; }
    done < <(xdotool search --onlyvisible --name '.' 2>/dev/null)

    if (( best_area >= SCREEN_WIDTH * SCREEN_HEIGHT / 4 )); then
        echo "${best}"
    fi
}

sleep 5
last=""
while true; do
    wid="$(find_game_window)"

    if [[ -n "${wid}" ]]; then
        if [[ "${wid}" != "${last}" ]]; then
            log "tracking window ${wid} ($(xdotool getwindowname "${wid}" 2>/dev/null))"
            last="${wid}"
            # Only reshape on first sight. Doing it every tick fights the game
            # if it ever moves its own window.
            wmctrl -i -r "${wid}" -b remove,maximized_vert,maximized_horz 2>/dev/null || true
            xdotool windowmove "${wid}" 0 0 2>/dev/null || true
            xdotool windowsize "${wid}" "${SCREEN_WIDTH}" "${SCREEN_HEIGHT}" 2>/dev/null || true
        fi

        active=$(xdotool getactivewindow 2>/dev/null || echo "")
        if [[ "${active}" != "${wid}" ]]; then
            xdotool windowactivate "${wid}" 2>/dev/null || true
            xdotool windowfocus "${wid}" 2>/dev/null || true
        fi

        # Publish the id so the streamer could capture this window directly if
        # we ever move off root capture.
        echo "${wid}" > /run/cnc/game-window-id 2>/dev/null || true
    else
        last=""
    fi
    sleep 2
done
