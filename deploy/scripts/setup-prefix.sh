#!/usr/bin/env bash
# Provision the Wine prefix. Idempotent: safe to run on every container start.
#
# Responsibilities:
#   1. Create the prefix (win64 by default; win32 also supported).
#   2. Install DXVK's d3d8/d3d9 DLLs into the right system directory.
#   3. Write the registry keys the retail Zero Hour binary looks for.
#   4. Seed My Documents\...Zero Hour Data\Options.ini with a sane resolution.
set -euo pipefail

log() { printf '[prefix] %s\n' "$*" >&2; }

STAMP="${WINEPREFIX}/.cnc-provisioned"
DXVK_VERSION="$(cat /opt/dxvk/VERSION 2>/dev/null || echo unknown)"
WANT_STAMP="arch=${WINEARCH} renderer=${RENDERER} dxvk=${DXVK_VERSION}"

# ---------------------------------------------------------------------------
# 1. Create / update the prefix
# ---------------------------------------------------------------------------
export WINEDLLOVERRIDES="mscoree=d;mshtml=d"   # never prompt for mono/gecko

if [[ ! -f "${WINEPREFIX}/system.reg" ]]; then
    log "creating ${WINEARCH} prefix at ${WINEPREFIX} (first run, this takes a minute)"
    wineboot --init
    wineserver -w
else
    log "reusing existing prefix at ${WINEPREFIX}"
fi

# ---------------------------------------------------------------------------
# 2. DXVK
# ---------------------------------------------------------------------------
# Where the 32-bit DLLs belong depends on the prefix architecture:
#   win64 prefix -> 32-bit DLLs live in syswow64, 64-bit in system32
#   win32 prefix -> 32-bit DLLs live in system32 (there is no syswow64)
install_dxvk() {
    local sys32="${WINEPREFIX}/drive_c/windows/system32"
    local syswow="${WINEPREFIX}/drive_c/windows/syswow64"

    if [[ "${WINEARCH}" == "win32" ]]; then
        log "installing DXVK ${DXVK_VERSION} x32 -> system32 (pure 32-bit prefix)"
        install -m644 /opt/dxvk/x32/d3d8.dll  "${sys32}/d3d8.dll"
        install -m644 /opt/dxvk/x32/d3d9.dll  "${sys32}/d3d9.dll"
    else
        log "installing DXVK ${DXVK_VERSION} x32 -> syswow64, x64 -> system32"
        mkdir -p "${syswow}"
        install -m644 /opt/dxvk/x32/d3d8.dll  "${syswow}/d3d8.dll"
        install -m644 /opt/dxvk/x32/d3d9.dll  "${syswow}/d3d9.dll"
        install -m644 /opt/dxvk/x64/d3d9.dll  "${sys32}/d3d9.dll"
        if [[ -f /opt/dxvk/x64/d3d8.dll ]]; then
            install -m644 /opt/dxvk/x64/d3d8.dll "${sys32}/d3d8.dll"
        fi
    fi
}

remove_dxvk() {
    log "removing DXVK DLLs so Wine's builtin wined3d is used"
    rm -f "${WINEPREFIX}/drive_c/windows/system32/d3d8.dll" \
          "${WINEPREFIX}/drive_c/windows/system32/d3d9.dll" \
          "${WINEPREFIX}/drive_c/windows/syswow64/d3d8.dll" \
          "${WINEPREFIX}/drive_c/windows/syswow64/d3d9.dll"
    wineboot -u >/dev/null 2>&1 || true
}

case "${RENDERER}" in
    dxvk)    install_dxvk ;;
    wined3d) remove_dxvk ;;
    *)       log "unknown RENDERER='${RENDERER}', defaulting to wined3d"; remove_dxvk ;;
esac

# DXVK tuning for this title. Rationale:
#   maxFrameLatency=1 / presentInterval=0 -- we are streaming, so we want the
#     freshest frame on the X screen and no vsync stall; the game self-limits
#     to ~30fps anyway.
#   numCompilerThreads / state cache -- Zero Hour's menus issue a very large
#     number of tiny draws; see dxvk issue #4112.
cat > "${WINEPREFIX}/dxvk.conf" <<'DXVKCONF'
# Tuning for C&C Generals: Zero Hour (Direct3D 8) under DXVK.
d3d8.maxFrameLatency = 1
d3d8.presentInterval = 0
d3d9.maxFrameLatency = 1
d3d9.presentInterval = 0

# Zero Hour submits a lot of very small draw calls, especially in the shell
# menus. Batching them is a large win.
d3d8.batching = True

# The engine's fixed-function math is sensitive to float behaviour.
d3d8.floatEmulation = Auto

# Persist the pipeline cache on the prefix volume so the second launch is fast.
dxvk.enableStateCache = True

# Uncomment to get an on-screen overlay confirming DXVK is actually in use.
# The same can be done at runtime with DXVK_HUD=version,fps,api.
# dxvk.hud = version,fps,api
DXVKCONF

# ---------------------------------------------------------------------------
# 3. Registry keys
# ---------------------------------------------------------------------------
# GlobalData.cpp reads the user-data leaf name and registry.cpp reads
# InstallPath / Language / Version from
#   HKLM|HKCU  SOFTWARE\Electronic Arts\EA Games\Command and Conquer Generals Zero Hour
# A 32-bit process on a win64 prefix is redirected into Wow6432Node, so we
# write both locations. A fresh Wine prefix has none of this, and the game will
# fall back to guesses (or fail to find its data) without it.
GAME_DIR_WIN="$(WINEDEBUG=-all winepath -w "${GAME_DIR}" 2>/dev/null || echo 'Z:\game')"
GAME_DIR_REG="${GAME_DIR_WIN//\\/\\\\}"

REGFILE="$(mktemp)"
cat > "${REGFILE}" <<REG
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\\Software\\Electronic Arts\\EA Games\\Command and Conquer Generals Zero Hour]
"InstallPath"="${GAME_DIR_REG}"
"Language"="english"
"UserDataLeafName"="Command and Conquer Generals Zero Hour Data"
"Version"=dword:00000104

[HKEY_LOCAL_MACHINE\\Software\\Wow6432Node\\Electronic Arts\\EA Games\\Command and Conquer Generals Zero Hour]
"InstallPath"="${GAME_DIR_REG}"
"Language"="english"
"UserDataLeafName"="Command and Conquer Generals Zero Hour Data"
"Version"=dword:00000104

[HKEY_CURRENT_USER\\Software\\Electronic Arts\\EA Games\\Command and Conquer Generals Zero Hour]
"InstallPath"="${GAME_DIR_REG}"
"Language"="english"
"UserDataLeafName"="Command and Conquer Generals Zero Hour Data"

[HKEY_LOCAL_MACHINE\\Software\\Electronic Arts\\EA Games\\Generals]
"InstallPath"="${GAME_DIR_REG}"
"Language"="english"

[HKEY_LOCAL_MACHINE\\Software\\Wow6432Node\\Electronic Arts\\EA Games\\Generals]
"InstallPath"="${GAME_DIR_REG}"
"Language"="english"

; Route Wine audio through PulseAudio (the container runs a null sink that the
; encoder captures from).
[HKEY_CURRENT_USER\\Software\\Wine\\Drivers]
"Audio"="pulse"

; The game is a 2003 title that predates DPI awareness. Pin the prefix to 96dpi
; so it never gets scaled underneath us -- the capture must be pixel-exact.
[HKEY_CURRENT_USER\\Control Panel\\Desktop]
"LogPixels"=dword:00000060

; Explicitly disable Wine's virtual-desktop shim. We manage the window with
; openbox instead, so the game window maps 1:1 onto the captured X screen.
[HKEY_CURRENT_USER\\Software\\Wine\\Explorer]
"Desktop"=-
REG

log "applying registry keys (InstallPath=${GAME_DIR_WIN})"
wine regedit /S "${REGFILE}" || log "WARNING: regedit failed"
rm -f "${REGFILE}"
wineserver -w

# ---------------------------------------------------------------------------
# 4. Seed Options.ini
# ---------------------------------------------------------------------------
# Zero Hour stores per-user settings in
#   My Documents\Command and Conquer Generals Zero Hour Data\Options.ini
# Resolution is stored as "Resolution = <x> <y>" (OptionsMenu.cpp uses
# sscanf "%d%d"). Seeding it means the first launch already matches the
# capture geometry instead of coming up at 800x600.
USERDOCS="${WINEPREFIX}/drive_c/users/${USER}/Documents"
[[ -d "${USERDOCS}" ]] || USERDOCS="${WINEPREFIX}/drive_c/users/$(id -un)/Documents"
DATADIR="${USERDOCS}/Command and Conquer Generals Zero Hour Data"
mkdir -p "${DATADIR}"

if [[ ! -f "${DATADIR}/Options.ini" ]]; then
    log "seeding Options.ini at ${SCREEN_WIDTH}x${SCREEN_HEIGHT}"
    cat > "${DATADIR}/Options.ini" <<INI
Resolution = ${SCREEN_WIDTH} ${SCREEN_HEIGHT}
StaticGameLOD = Custom
IdealStaticGameLOD = Custom
TextureReduction = 0
MaxParticleCount = 2500
UseShadowVolumes = no
UseShadowDecals = yes
UseCloudMap = yes
UseLightMap = yes
ShowTrees = yes
ShowSoftWaterEdge = yes
ExtraAnimations = yes
DynamicLOD = no
HeatEffects = yes
BuildingOcclusion = yes
Gamma = 50
MusicVolume = 55
SoundVolume = 70
ScrollFactor = 50
SendDelay = no
UseAlternateMouse = no
Retaliation = yes
UseDoubleClickAttackMove = no
INI
else
    log "Options.ini already exists; leaving it alone"
fi

echo "${WANT_STAMP}" > "${STAMP}"
log "prefix ready"
