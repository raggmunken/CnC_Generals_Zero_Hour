#!/usr/bin/env bash
set -euo pipefail
# +extension GLX and +render are required for wined3d's OpenGL path.
# -noreset keeps the server alive if the last client (the game) exits.
exec Xvfb "${DISPLAY}" \
    -screen 0 "${SCREEN_WIDTH}x${SCREEN_HEIGHT}x${SCREEN_DEPTH}" \
    -nolisten tcp -noreset \
    +extension GLX +extension RANDR +extension RENDER +extension XTEST \
    -dpi 96
