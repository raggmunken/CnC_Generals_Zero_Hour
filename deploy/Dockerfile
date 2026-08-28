# syntax=docker/dockerfile:1.7
#
# Command & Conquer: Generals Zero Hour -- browser delivery container (Phase 1)
#
# Runs the STOCK RETAIL WIN32 GAME BINARY under Wine on a headless X server,
# captures the X screen with GStreamer, encodes H.264, and ships it to a browser
# over WebRTC. Input comes back over a WebRTC DataChannel (WebSocket fallback)
# and is injected with XTEST.
#
# NOTHING licensed is baked into this image. The game install is bind-mounted at
# runtime (see docker-compose.yml / run.sh).
#
# Build:
#   docker build -t cnc-web:phase1 deploy/
#
FROM ubuntu:24.04

# ---------------------------------------------------------------------------
# Build-time knobs
# ---------------------------------------------------------------------------
# WineHQ branch: staging | devel | stable.  staging is the most forgiving for
# ancient D3D8 titles.  If the WineHQ repo has no i386 build for your branch,
# set WINE_SOURCE=distro to use Ubuntu's own wine + wine32.
ARG WINE_BRANCH=staging
ARG WINE_SOURCE=winehq

# DXVK release that provides d3d8.dll (D3D8 support landed in DXVK 2.4).
# NOTE: DXVK 3.x requires a Vulkan 1.4-era driver. Ubuntu 24.04's stock Mesa
# lavapipe (software Vulkan) only exposes Vulkan 1.3, so 3.x will refuse to
# start under software rendering here. 2.7.1 is the safe default; bump it if
# you have a modern GPU driver (or set MESA_PPA=1 below).
ARG DXVK_VERSION=2.7.1

# Set to 1 to pull newer Mesa from the kisak-mesa PPA (needed for DXVK 3.x on
# llvmpipe/lavapipe, and generally better software rendering).
ARG MESA_PPA=0

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    TZ=UTC

# ---------------------------------------------------------------------------
# Base OS + 32-bit multiarch (the game is a 32-bit Win32 binary)
# ---------------------------------------------------------------------------
RUN set -eux; \
    dpkg --add-architecture i386; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg software-properties-common \
        xz-utils cabextract p7zip-full unzip \
        procps psmisc net-tools iproute2 tini locales; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Optional: newer Mesa (better llvmpipe/lavapipe; required by DXVK 3.x)
# ---------------------------------------------------------------------------
RUN set -eux; \
    if [ "${MESA_PPA}" = "1" ]; then \
        add-apt-repository -y ppa:kisak/kisak-mesa; \
    fi

# ---------------------------------------------------------------------------
# Graphics stack: Mesa GL (for wined3d) + Vulkan loader & ICDs (for DXVK),
# both 64-bit and 32-bit.
# ---------------------------------------------------------------------------
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        mesa-utils mesa-utils-bin \
        libgl1-mesa-dri libgl1-mesa-dri:i386 \
        libglx-mesa0 libglx-mesa0:i386 \
        libgl1 libgl1:i386 \
        libvulkan1 libvulkan1:i386 \
        mesa-vulkan-drivers mesa-vulkan-drivers:i386 \
        vulkan-tools \
        libdrm2 libdrm2:i386 \
        libgbm1; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Headless display + window manager + input tools
#   Xvfb  : virtual X server. Supports XTEST (input injection) and XFIXES
#           (so ximagesrc can composite the mouse cursor into the capture).
#   openbox: gives the Wine window focus and strips decorations so the game
#           window lines up 1:1 with the captured screen.
# ---------------------------------------------------------------------------
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        xvfb x11-utils x11-xserver-utils xdotool wmctrl \
        openbox xterm \
        libxtst6 libxtst6:i386 libxfixes3 libxfixes3:i386; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Audio: PulseAudio with a null sink. Wine renders into the null sink, and
# GStreamer captures its monitor source.
# ---------------------------------------------------------------------------
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        pulseaudio pulseaudio-utils \
        libpulse0 libpulse0:i386 \
        alsa-utils libasound2t64 libasound2t64:i386 libasound2-plugins:i386; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# GStreamer: capture + encode + WebRTC transport
# ---------------------------------------------------------------------------
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        gstreamer1.0-tools gstreamer1.0-x gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-good gstreamer1.0-plugins-bad \
        gstreamer1.0-plugins-ugly gstreamer1.0-libav \
        gstreamer1.0-pulseaudio gstreamer1.0-nice gstreamer1.0-vaapi \
        libnice10 gstreamer1.0-gl \
        python3 python3-gi python3-gi-cairo python3-aiohttp python3-xlib \
        gir1.2-gstreamer-1.0 gir1.2-gst-plugins-base-1.0 \
        gir1.2-gst-plugins-bad-1.0 \
        supervisor; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Wine
# ---------------------------------------------------------------------------
RUN set -eux; \
    if [ "${WINE_SOURCE}" = "winehq" ]; then \
        mkdir -pm755 /etc/apt/keyrings; \
        wget -qO /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key; \
        wget -qNP /etc/apt/sources.list.d/ https://dl.winehq.org/wine-builds/ubuntu/dists/noble/winehq-noble.sources; \
        apt-get update; \
        apt-get install -y --install-recommends "winehq-${WINE_BRANCH}"; \
    else \
        apt-get update; \
        apt-get install -y --no-install-recommends wine wine32 wine64 libwine libwine:i386 fonts-wine; \
    fi; \
    rm -rf /var/lib/apt/lists/*

# winetricks is only used for optional troubleshooting verbs; it is not on the
# happy path.
RUN set -eux; \
    wget -qO /usr/local/bin/winetricks \
        https://raw.githubusercontent.com/Winetricks/winetricks/master/src/winetricks; \
    chmod +x /usr/local/bin/winetricks

# ---------------------------------------------------------------------------
# DXVK (D3D8/9/10/11 -> Vulkan). d3d8 needs BOTH d3d8.dll and d3d9.dll.
# The DLLs are staged in /opt/dxvk and copied into the Wine prefix at runtime,
# so a prefix on a persistent volume can be re-provisioned without a rebuild.
# ---------------------------------------------------------------------------
RUN set -eux; \
    wget -qO /tmp/dxvk.tar.gz \
        "https://github.com/doitsujin/dxvk/releases/download/v${DXVK_VERSION}/dxvk-${DXVK_VERSION}.tar.gz"; \
    mkdir -p /opt/dxvk; \
    tar -xzf /tmp/dxvk.tar.gz -C /opt/dxvk --strip-components=1; \
    rm -f /tmp/dxvk.tar.gz; \
    ls -la /opt/dxvk/x32 /opt/dxvk/x64; \
    test -f /opt/dxvk/x32/d3d8.dll; \
    test -f /opt/dxvk/x32/d3d9.dll; \
    echo "${DXVK_VERSION}" > /opt/dxvk/VERSION

# ---------------------------------------------------------------------------
# Application files
# ---------------------------------------------------------------------------
RUN useradd -m -u 1000 -s /bin/bash wine

# NOTE: the build context is the REPOSITORY ROOT, not deploy/, because the
# browser client lives in the top-level web/ directory. deploy/run.sh and
# docker-compose.yml both set the context accordingly, and
# deploy/Dockerfile.dockerignore keeps the game source out of the context.
COPY deploy/config/     /opt/cnc/config/
COPY deploy/scripts/    /opt/cnc/scripts/
COPY deploy/streamer/   /opt/cnc/streamer/
COPY web/               /opt/cnc/web/

RUN chmod +x /opt/cnc/scripts/*.sh && \
    mkdir -p /var/log/cnc /run/cnc && \
    chown -R wine:wine /opt/cnc /var/log/cnc /run/cnc

# ---------------------------------------------------------------------------
# Runtime defaults. Every one of these is overridable from docker-compose.
# ---------------------------------------------------------------------------
ENV HOME=/home/wine \
    USER=wine \
    DISPLAY=:0 \
    SCREEN_WIDTH=1600 \
    SCREEN_HEIGHT=900 \
    SCREEN_DEPTH=24 \
    GAME_FPS=30 \
    WINEPREFIX=/prefix \
    WINEARCH=win64 \
    WINEDEBUG=-all \
    GAME_DIR=/game \
    GAME_EXE=game.dat \
    GAME_ARGS="-win -quickstart" \
    RENDERER=dxvk \
    GPU=none \
    ENCODER=x264 \
    VIDEO_BITRATE_KBPS=12000 \
    AUDIO_ENABLED=1 \
    STREAM_PORT=8080 \
    STUN_SERVER=stun://stun.l.google.com:19302 \
    TURN_SERVER= \
    PULSE_SERVER=unix:/run/cnc/pulse/native \
    PULSE_SINK=cnc_sink

EXPOSE 8080

HEALTHCHECK --interval=20s --timeout=5s --start-period=90s --retries=5 \
    CMD /opt/cnc/scripts/healthcheck.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/opt/cnc/scripts/entrypoint.sh"]
