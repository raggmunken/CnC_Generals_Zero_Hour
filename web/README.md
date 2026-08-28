# Browser client

The thin client for the Phase 1 delivery path: a `<video>` element fed by
WebRTC, plus an input layer built specifically for an RTS rather than for
generic remote desktop.

It is served by the streamer inside the container (`deploy/streamer/server.py`
mounts this directory), so there is no build step, no bundler and no
dependencies. Edit a file, restart the `streamer` unit, reload the tab.

| File | Responsibility |
|---|---|
| `index.html` | Markup, the pre-capture overlay, the HUD |
| `css/style.css` | Layout, and the gesture lockdown that stops the browser selecting text under a drag-select box or pinch-zooming the page |
| `js/input.js` | Pointer and keyboard mapping — edge snapping, pointer lock, keyboard lock, box-drag ordering, wheel normalisation, release-all |
| `js/client.js` | Signalling, `RTCPeerConnection`, the input data channel, reconnect and stall detection |
| `js/app.js` | Wiring between the two, plus the overlay and HUD |

The reasoning behind the input design — and the specific facts about the engine
that drive it — is in [`../deploy/README.md`](../deploy/README.md#why-the-input-layer-is-not-generic-remote-desktop).

Load order matters: `input.js` and `client.js` define globals that `app.js`
consumes, and `app.js` runs immediately.
