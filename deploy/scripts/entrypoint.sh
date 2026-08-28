#!/usr/bin/env bash
# Container entrypoint. Validates the environment, provisions the Wine prefix
# on first run, then hands over to supervisord which owns the long-lived
# processes (Xvfb, PulseAudio, openbox, the game, the streamer).
set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }
die() { printf '[entrypoint] FATAL: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Sanity checks on the bind-mounted game directory
# ---------------------------------------------------------------------------
[[ -d "${GAME_DIR}" ]] || die "GAME_DIR '${GAME_DIR}' is not a directory. \
Bind-mount your Zero Hour install there (see deploy/README.md)."

if [[ ! -f "${GAME_DIR}/${GAME_EXE}" ]]; then
    log "Could not find '${GAME_EXE}' in ${GAME_DIR}. Contents:"
    ls -la "${GAME_DIR}" | head -40 >&2
    # Try to auto-detect. Retail Zero Hour ships game.dat; some releases use
    # generals.exe as a launcher shim.
    for candidate in game.dat generals.exe GeneralsZH.exe game.exe; do
        if [[ -f "${GAME_DIR}/${candidate}" ]]; then
            log "Auto-detected game executable: ${candidate}"
            export GAME_EXE="${candidate}"
            break
        fi
    done
fi
[[ -f "${GAME_DIR}/${GAME_EXE}" ]] || die "No game executable found in ${GAME_DIR}."

if ! ls "${GAME_DIR}"/*.[bB][iI][gG] >/dev/null 2>&1; then
    log "WARNING: no .BIG archives found in ${GAME_DIR}. The game will not start \
without its asset archives."
fi

# ---------------------------------------------------------------------------
# Runtime directories and ownership
# ---------------------------------------------------------------------------
# Everything that touches the Wine prefix runs as the unprivileged `wine` user:
# Wine warns loudly about running as root, winetricks refuses outright, and a
# root-owned prefix on a persistent volume would then be unwritable by anything
# that came later.
RUN_UID="$(id -u wine)"
RUN_GID="$(id -g wine)"

mkdir -p /run/cnc/pulse "${WINEPREFIX}" "${HOME}/.cache" /var/log/cnc
install -d -m 1777 /tmp/.X11-unix
chown "${RUN_UID}:${RUN_GID}" /run/cnc /run/cnc/pulse /var/log/cnc 2>/dev/null || true
chown -R "${RUN_UID}:${RUN_GID}" "${HOME}" 2>/dev/null || true
# The prefix can hold tens of thousands of files once the DXVK shader cache
# fills up, so only walk it when the ownership is actually wrong.
if [[ "$(stat -c %u "${WINEPREFIX}" 2>/dev/null || echo -1)" != "${RUN_UID}" ]]; then
    log "taking ownership of ${WINEPREFIX}"
    chown -R "${RUN_UID}:${RUN_GID}" "${WINEPREFIX}" 2>/dev/null || \
        log "WARNING: could not chown ${WINEPREFIX}; the game may fail to write its prefix"
fi
export XDG_RUNTIME_DIR=/run/cnc

# ---------------------------------------------------------------------------
# Rendering mode
# ---------------------------------------------------------------------------
case "${GPU}" in
    none)
        log "GPU=none -> forcing software rendering (llvmpipe / lavapipe)"
        export LIBGL_ALWAYS_SOFTWARE=1
        export GALLIUM_DRIVER=llvmpipe
        # Point the Vulkan loader at lavapipe only, for both bitnesses.
        icds=$(ls /usr/share/vulkan/icd.d/lvp_icd.*.json 2>/dev/null | paste -sd: -)
        if [[ -n "${icds}" ]]; then
            export VK_ICD_FILENAMES="${icds}"
            export VK_DRIVER_FILES="${icds}"
        else
            log "WARNING: lavapipe ICD not found; DXVK will have no Vulkan device."
        fi
        ;;
    dri)
        log "GPU=dri -> using the host GPU via /dev/dri"
        [[ -e /dev/dri ]] || log "WARNING: /dev/dri is not present in the container."
        ;;
    *)
        die "Unknown GPU mode '${GPU}' (expected 'none' or 'dri')"
        ;;
esac

# ---------------------------------------------------------------------------
# Provision the Wine prefix (idempotent; safe to re-run on every boot)
# ---------------------------------------------------------------------------
# setpriv keeps the environment we just built, which `su` would discard.
if [[ "$(id -u)" -eq 0 ]]; then
    setpriv --reuid="${RUN_UID}" --regid="${RUN_GID}" --init-groups \
        /opt/cnc/scripts/setup-prefix.sh
else
    /opt/cnc/scripts/setup-prefix.sh
fi

# ---------------------------------------------------------------------------
# Render supervisord config and go
# ---------------------------------------------------------------------------
log "screen ${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH} @ ${GAME_FPS}fps"
log "renderer=${RENDERER} gpu=${GPU} encoder=${ENCODER} audio=${AUDIO_ENABLED}"
log "handing off to supervisord"

exec supervisord -c /opt/cnc/config/supervisord.conf
