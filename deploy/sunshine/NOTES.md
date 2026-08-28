# Sunshine evaluation

Sunshine was evaluated first, as the mature option, before any pipeline code
was written. This file records what it can and cannot do for **this** goal, and
ships ready-made configuration for using it as a comparison path.

## What Sunshine is very good at

* Actively maintained, official container images
  (`ghcr.io/lizardbyte/sunshine`, Ubuntu 24.04 base among others).
* Hardware encoding on NVENC / AMF / VA-API with an x264 software fallback, all
  tuned for game streaming rather than for desktop sharing.
* Battle-tested latency work: frame pacing, FEC, bitrate adaptation, HDR,
  gamepad emulation through `uinput`.
* A large user base, so failure modes are documented.

## Why it is not the Phase 1 primary path

1. **It does not speak WebRTC.** Sunshine implements NVIDIA's GameStream:
   RTSP for setup, ENet for control, encrypted RTP over UDP for media. No
   browser can connect to that directly. Getting a browser onto a Sunshine host
   requires a third process that links `moonlight-common-c`, terminates
   GameStream, and re-packages the media into WebRTC.

2. **That bridge is a whole product, not a library.** The one actively
   maintained implementation is `linckosz/moonlight-web` (GPLv3, C++/Qt 6). It
   is distributed as per-OS installers, bundles its own login and pairing
   wizard, does mDNS host discovery, and ships its own browser UI. There is no
   official container image. Embedding it headlessly is a project in itself.

3. **The browser UI would not be ours.** The brief calls for RTS-specific input
   handling — snapping onto the 3-pixel edge-scroll band, drag fidelity for box
   selection, Keyboard Lock so `Ctrl+1..9` reaches the game instead of
   switching browser tabs. Those live in the client. Using Sunshine's browser
   path means either accepting a generic remote-desktop input model or forking
   a Qt/C++ application plus its JS front end.

4. **Three hops instead of one.** X capture → GameStream RTP → WebRTC adds a
   decode/re-encode-or-repackage stage and one more failure domain, in a phase
   whose entire purpose is to find out whether the concept holds up.

5. **Container friction.** Sunshine injects input through `/dev/uinput`, which
   needs extra device access and privileges, and it wants its own virtual
   display plumbing on top of the X server the game already needs.

## Conclusion

For a browser-first Phase 1, GStreamer's `webrtcbin` reaches the browser in one
hop with no bridge, and leaves the input layer — the part that actually needs
thought here — entirely under our control. Sunshine remains the better answer
the moment a **native** Moonlight client is acceptable, and it is worth keeping
around as a latency yardstick: if Moonlight-native feels dramatically better
than the browser path on the same host, the gap is in our encoder or transport
settings rather than in the game or Wine.

## Using Sunshine as a comparison path

The config here is written for the display and audio the main container already
creates (`:0` at `SCREEN_WIDTH x SCREEN_HEIGHT`, PulseAudio sink `cnc_sink`).

1. Add these two volumes to the `game` service in `docker-compose.yml` so the
   X socket and the PulseAudio socket are reachable from a second container:

   ```yaml
       volumes:
         - x11socket:/tmp/.X11-unix
         - pulsesock:/run/cnc/pulse
   ```

   and declare them under the top-level `volumes:` key.

2. Bring the stack up with the override:

   ```sh
   docker compose \
     -f docker-compose.yml \
     -f sunshine/docker-compose.sunshine.yml \
     --profile sunshine up -d
   ```

3. Open `https://<host>:47990`, set a username and password, then pair a native
   Moonlight client with the PIN. The app list already contains a
   "Zero Hour (already running)" entry that attaches to the running game rather
   than launching anything.

This path is **untested**: it was written from the documented interfaces, not
run. Treat it as a starting point, not a working configuration.
