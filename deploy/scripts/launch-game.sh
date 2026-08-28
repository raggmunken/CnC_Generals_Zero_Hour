#!/usr/bin/env bash
# Launch the stock retail Zero Hour binary under Wine.
set -uo pipefail

log() { printf '[game] %s\n' "$*" >&2; }

export XDG_RUNTIME_DIR=/run/cnc

# Wait for the X server and the window manager to be up before starting the
# game -- Zero Hour clips the cursor to its window on WM_ACTIVATE, and starting
# before there is a WM to give it focus leaves input dead.
for _ in $(seq 1 60); do
    xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 && break
    sleep 0.5
done
xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1 || { log "X server never came up"; exit 1; }

# Disable X auto-repeat. The browser client sends discrete press/release pairs
# and the game reads DirectInput key *state*; server-side repeat would produce
# phantom keystrokes.
xset -display "${DISPLAY}" r off || true
# No screen blanking / DPMS on a headless server.
xset -display "${DISPLAY}" s off -dpms || true

# ---------------------------------------------------------------------------
# Renderer selection
# ---------------------------------------------------------------------------
# DXVK provides d3d8.dll + d3d9.dll; both must be overridden to native for the
# D3D8 path to be taken (DXVK's d3d8 is implemented on top of its own d3d9).
case "${RENDERER}" in
    dxvk)
        export WINEDLLOVERRIDES="d3d8,d3d9=n,b;mscoree=d;mshtml=d"
        export DXVK_CONFIG_FILE="${WINEPREFIX}/dxvk.conf"
        export DXVK_STATE_CACHE_PATH="${WINEPREFIX}/dxvk-cache"
        export DXVK_LOG_PATH="${WINEPREFIX}/dxvk-logs"
        mkdir -p "${DXVK_STATE_CACHE_PATH}" "${DXVK_LOG_PATH}"
        log "renderer: DXVK (D3D8 -> Vulkan)"
        ;;
    wined3d)
        export WINEDLLOVERRIDES="mscoree=d;mshtml=d"
        log "renderer: wined3d (D3D8 -> OpenGL)"
        ;;
    *)
        export WINEDLLOVERRIDES="mscoree=d;mshtml=d"
        log "unknown RENDERER='${RENDERER}', falling back to wined3d"
        ;;
esac

# The game is a large-address-unaware 2003 binary; leave the default heap
# layout alone but keep Wine quiet.
export WINEDEBUG="${WINEDEBUG:--all}"

# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------
# -win / -xres / -yres / -quickstart / -noshellmap are all parsed by RETAIL
# builds (CommandLine.cpp registers them outside the _DEBUG/_INTERNAL guard).
#
# Windowed mode is not a cosmetic choice: a fullscreen D3D8 device tries to
# change the display mode, and Xvfb has exactly one fixed mode. Running
# windowed at exactly the screen size, with openbox stripping decorations,
# makes the game window line up 1:1 with what we capture -- which the 3-pixel
# edge-scroll band in LookAtTranslator depends on.
ARGS=(-win -xres "${SCREEN_WIDTH}" -yres "${SCREEN_HEIGHT}")

# Merge GAME_ARGS, dropping anything that would fight the geometry we just
# pinned. -xres and -yres take a value, so their argument has to be dropped
# with them or it would be passed to the game as a bare token.
# shellcheck disable=SC2206
EXTRA=( ${GAME_ARGS:-} )
skip_next=0
for a in "${EXTRA[@]+"${EXTRA[@]}"}"; do
    if [[ "${skip_next}" -eq 1 ]]; then skip_next=0; continue; fi
    case "$a" in
        -xres|-yres)      skip_next=1 ;;
        -win|-fullscreen) ;;
        "")               ;;
        *)                ARGS+=("$a") ;;
    esac
done

cd "${GAME_DIR}" || { log "cannot cd to ${GAME_DIR}"; exit 1; }

log "exec: wine ${GAME_EXE} ${ARGS[*]}"
exec wine "${GAME_EXE}" "${ARGS[@]}"
