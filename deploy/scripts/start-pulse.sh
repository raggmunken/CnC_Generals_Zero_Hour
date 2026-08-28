#!/usr/bin/env bash
set -euo pipefail
# A null sink plus its monitor source: Wine renders into the sink, GStreamer
# captures the monitor. No hardware audio device is involved anywhere.
export XDG_RUNTIME_DIR=/run/cnc
mkdir -p /run/cnc/pulse
exec pulseaudio \
    --exit-idle-time=-1 \
    --disallow-exit \
    --disable-shm=true \
    -n \
    --load="module-native-protocol-unix auth-anonymous=1 socket=/run/cnc/pulse/native" \
    --load="module-null-sink sink_name=${PULSE_SINK} sink_properties=device.description=CnCVirtualSink rate=48000 channels=2" \
    --load="module-always-sink" \
    --log-target=stderr --log-level=notice
