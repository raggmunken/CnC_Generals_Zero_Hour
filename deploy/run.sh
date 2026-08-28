#!/usr/bin/env bash
#
# One-shot launcher.
#
#   ./deploy/run.sh /path/to/Command\ and\ Conquer\ Generals\ Zero\ Hour
#
# Validates the game directory, writes/updates deploy/.env, builds the image if
# needed, brings the stack up and prints the URL to open.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
ENV_FILE="${HERE}/.env"

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$c_grn" "$c_off" "$*"; }
warn() { printf '%s!%s %s\n' "$c_yel" "$c_off" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }

usage() {
    cat <<USAGE
Usage: $0 [options] <path-to-zero-hour-install>

Options:
  -r, --renderer  dxvk|wined3d     D3D8 translation layer  (default: dxvk)
  -g, --gpu       none|dri         software or host GPU    (default: none)
  -s, --size      WIDTHxHEIGHT     capture geometry        (default: 1600x900)
  -p, --port      PORT             listen port             (default: 8080)
  -e, --encoder   x264|vaapi|nvenc video encoder           (default: x264)
      --tls                        also run the TLS proxy on :8443
      --build                      force an image rebuild
      --logs                       follow logs after starting
  -h, --help                       this text

The game directory is bind-mounted read-only. Nothing licensed is copied into
the image.
USAGE
}

RENDERER=""; GPU=""; SIZE=""; PORT=""; ENCODER=""
WITH_TLS=0; FORCE_BUILD=0; FOLLOW_LOGS=0
GAME_PATH_ARG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -r|--renderer) RENDERER="${2:?}"; shift 2 ;;
        -g|--gpu)      GPU="${2:?}";      shift 2 ;;
        -s|--size)     SIZE="${2:?}";     shift 2 ;;
        -p|--port)     PORT="${2:?}";     shift 2 ;;
        -e|--encoder)  ENCODER="${2:?}";  shift 2 ;;
        --tls)         WITH_TLS=1;        shift ;;
        --build)       FORCE_BUILD=1;     shift ;;
        --logs)        FOLLOW_LOGS=1;     shift ;;
        -h|--help)     usage; exit 0 ;;
        -*)            die "unknown option: $1" ;;
        *)             GAME_PATH_ARG="$1"; shift ;;
    esac
done

# ---------------------------------------------------------------------------
# Prerequisites
# ---------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "docker is not installed or not on PATH"
if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
else
    die "docker compose (v2 plugin or the standalone docker-compose) is required"
fi
docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon (is it running? are you in the docker group?)"

# ---------------------------------------------------------------------------
# Game directory
# ---------------------------------------------------------------------------
if [[ -z "${GAME_PATH_ARG}" ]]; then
    if [[ -f "${ENV_FILE}" ]] && grep -q '^GAME_PATH=' "${ENV_FILE}"; then
        GAME_PATH_ARG="$(grep '^GAME_PATH=' "${ENV_FILE}" | head -1 | cut -d= -f2-)"
        say "${c_dim}using GAME_PATH from .env${c_off}"
    else
        usage; exit 1
    fi
fi

[[ -d "${GAME_PATH_ARG}" ]] || die "not a directory: ${GAME_PATH_ARG}"
GAME_PATH="$(cd "${GAME_PATH_ARG}" && pwd)"

GAME_EXE=""
for candidate in game.dat generals.exe GeneralsZH.exe game.exe; do
    if [[ -f "${GAME_PATH}/${candidate}" ]]; then GAME_EXE="${candidate}"; break; fi
done
[[ -n "${GAME_EXE}" ]] || die "no game executable (game.dat / generals.exe) found in ${GAME_PATH}"
ok "game executable: ${GAME_EXE}"

big_count=$(find "${GAME_PATH}" -maxdepth 1 -iname '*.big' 2>/dev/null | wc -l | tr -d ' ')
if [[ "${big_count}" -eq 0 ]]; then
    die "no .BIG archives in ${GAME_PATH}. That is not a complete install."
fi
ok "${big_count} .BIG archives found"

# Zero Hour needs its expansion archives; the base-game directory alone will
# start and then fail to find data.
if ! find "${GAME_PATH}" -maxdepth 1 -iname 'ZeroHour*.big' 2>/dev/null | grep -q .; then
    warn "no ZeroHour*.big found — this may be the base Generals install rather than Zero Hour"
fi

# ---------------------------------------------------------------------------
# .env
# ---------------------------------------------------------------------------
if [[ ! -f "${ENV_FILE}" ]]; then
    cp "${HERE}/.env.example" "${ENV_FILE}"
    ok "created ${ENV_FILE} from .env.example"
fi

set_env() {
    local key="$1" value="$2"
    [[ -n "${value}" ]] || return 0
    if grep -q "^${key}=" "${ENV_FILE}"; then
        # Use a delimiter that cannot appear in a path.
        python3 - "$ENV_FILE" "$key" "$value" <<'PY'
import sys
path, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).read().splitlines(True)
out = []
for line in lines:
    if line.startswith(key + "="):
        out.append(f"{key}={value}\n")
    else:
        out.append(line)
open(path, "w").writelines(out)
PY
    else
        printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
    fi
}

set_env GAME_PATH "${GAME_PATH}"
set_env GAME_EXE  "${GAME_EXE}"
[[ -n "${RENDERER}" ]] && set_env RENDERER "${RENDERER}"
[[ -n "${GPU}"      ]] && set_env GPU      "${GPU}"
[[ -n "${PORT}"     ]] && set_env STREAM_PORT "${PORT}"
[[ -n "${ENCODER}"  ]] && set_env ENCODER  "${ENCODER}"
if [[ -n "${SIZE}" ]]; then
    [[ "${SIZE}" =~ ^([0-9]+)x([0-9]+)$ ]] || die "--size must look like 1600x900"
    set_env SCREEN_WIDTH  "${BASH_REMATCH[1]}"
    set_env SCREEN_HEIGHT "${BASH_REMATCH[2]}"
fi

# ---------------------------------------------------------------------------
# GPU sanity
# ---------------------------------------------------------------------------
EFF_GPU="$(grep '^GPU=' "${ENV_FILE}" | head -1 | cut -d= -f2- || echo none)"
if [[ "${EFF_GPU}" == "dri" && ! -e /dev/dri ]]; then
    warn "GPU=dri but /dev/dri does not exist on this host; falling back to GPU=none"
    set_env GPU none
    EFF_GPU=none
fi
if [[ "${EFF_GPU}" == "dri" ]]; then
    warn "GPU=dri also needs the devices: block uncommented in docker-compose.yml"
fi

mkdir -p "${HERE}/logs"

# ---------------------------------------------------------------------------
# Up
# ---------------------------------------------------------------------------
PROFILES=()
[[ "${WITH_TLS}" -eq 1 ]] && PROFILES+=(--profile tls)

BUILD_FLAG=()
if [[ "${FORCE_BUILD}" -eq 1 ]] || ! docker image inspect cnc-web:phase1 >/dev/null 2>&1; then
    BUILD_FLAG=(--build)
    say "${c_dim}building the image (first build pulls Wine, Mesa and GStreamer — expect several minutes)${c_off}"
fi

cd "${HERE}"
"${COMPOSE[@]}" --env-file "${ENV_FILE}" "${PROFILES[@]}" up -d "${BUILD_FLAG[@]}"

EFF_PORT="$(grep '^STREAM_PORT=' "${ENV_FILE}" | head -1 | cut -d= -f2- || echo 8080)"

cat <<BANNER

$(ok "stack is up")

  Open ${c_grn}http://localhost:${EFF_PORT}/${c_off}

  From another machine, tunnel first — WebRTC, pointer lock and keyboard lock
  all require a secure context, and plain http:// to a remote host is not one:

      ssh -L ${EFF_PORT}:localhost:${EFF_PORT} $(whoami)@$(hostname)

  ...then open http://localhost:${EFF_PORT}/ on your own machine.
  (Or run with --tls and use https://<host>:8443/ instead.)

  Logs:    ${COMPOSE[*]} --env-file ${ENV_FILE} logs -f game
           tail -f ${HERE}/logs/game.err        # Wine + the game
           tail -f ${HERE}/logs/streamer.err    # capture, encode, WebRTC
  Stop:    ${COMPOSE[*]} --env-file ${ENV_FILE} down

BANNER

if [[ "${FOLLOW_LOGS}" -eq 1 ]]; then
    exec "${COMPOSE[@]}" --env-file "${ENV_FILE}" logs -f game
fi
