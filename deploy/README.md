# Generals Zero Hour in a browser — Phase 1

Runs the **stock retail Zero Hour binary** inside a container under Wine on a
headless X server, encodes the X screen to H.264, and streams it to a browser
over WebRTC. Input comes back over a WebRTC data channel and is injected with
XTEST. No engine changes, no custom build, no WASM.

Matches are configured through the game's own skirmish menu, which already
supports red/blue teams and any mix of human and AI players. Nothing here needs
to know about that.

> **Status: untested end to end.** This was written and reviewed but never run
> against a real game install or a real GPU. See
> [What is verified and what is not](#what-is-verified-and-what-is-not) before
> you budget time on it.

---

## Contents

| Path | What it is |
|---|---|
| `Dockerfile` | Ubuntu 24.04 + i386 multiarch, Wine, DXVK, Mesa, GStreamer, Xvfb, PulseAudio |
| `docker-compose.yml` | The stack. Host networking by default (this matters — see [Networking](#networking-and-why-host-mode)) |
| `run.sh` | One command: validate the install, write `.env`, build, up, print the URL |
| `.env.example` | Every knob, with the reasoning |
| `scripts/` | Entrypoint, Wine prefix provisioning, game launch, focus watchdog |
| `config/` | supervisord, openbox, Caddy |
| `streamer/` | `server.py` (signalling + static + input), `pipeline.py` (GStreamer), `xinput.py` (XTEST) |
| `sunshine/` | The Sunshine evaluation, and config for using it as a comparison path |
| `../web/` | The browser client |

---

## Prerequisites

**On the host**

* Linux with Docker Engine 24+ and the Compose v2 plugin.
  Run `docker compose version` to confirm.
* ~6 GB of disk for the image (Wine + Mesa + GStreamer are not small).
* 4 CPU cores minimum for software rendering + software encoding at 1600×900.
  Two cores will produce a slideshow.
* Optionally `/dev/dri` for GPU rendering and VA-API encoding.

**Content you must own**

A complete Command & Conquer: Generals **Zero Hour** installation — the
directory containing `game.dat` and the `*.BIG` archives. It is bind-mounted
read-only. Nothing licensed is ever copied into the image, and the image is not
distributable with content in it because there is none.

Typical locations:

```
Steam    ~/.steam/steam/steamapps/common/Command and Conquer Generals Zero Hour
EA App   .../EA Games/Command and Conquer Generals Zero Hour
```

**In the browser**

Chromium 111+ or Firefox 120+. Chromium is strongly preferred: the
[Keyboard Lock API][kbdlock] is Chromium-only, and without it `Ctrl+1…9` —
control groups, the single most-used binding in an RTS — switches browser tabs
instead of reaching the game.

[kbdlock]: https://developer.mozilla.org/en-US/docs/Web/API/Keyboard/lock

---

## Quick start

```sh
git clone <this repo>
cd <this repo>

./deploy/run.sh "/path/to/Command and Conquer Generals Zero Hour"
```

`run.sh` checks the directory really is a Zero Hour install, writes
`deploy/.env`, builds the image on first run (expect several minutes), brings
the stack up and prints the URL.

Then open **`http://localhost:8080/`** and press **Connect**.

Useful flags:

```sh
./deploy/run.sh --renderer wined3d --gpu none "…"   # safest software config
./deploy/run.sh --gpu dri --encoder vaapi "…"       # host GPU
./deploy/run.sh --size 1024x768 "…"                 # 4:3, the best-tested aspect
./deploy/run.sh --tls "…"                           # also run the TLS proxy
./deploy/run.sh --build --logs "…"                  # rebuild and follow logs
```

Or drive Compose directly:

```sh
cp deploy/.env.example deploy/.env
$EDITOR deploy/.env          # set GAME_PATH
cd deploy && docker compose --env-file .env up --build
```

---

## Connecting from another machine

**WebRTC, Pointer Lock and Keyboard Lock all require a secure context.** Plain
`http://` to a remote host is not one, and all three fail in ways that look
like a broken stream rather than a browser policy. Two options:

**SSH tunnel (simplest, no certificates).** The browser sees `localhost`, which
is always a secure context:

```sh
ssh -L 8080:localhost:8080 user@gamehost
# then open http://localhost:8080/ on your own machine
```

**TLS proxy.** Bring the stack up with `--tls` (or
`docker compose --profile tls up`) and use `https://<host>:8443/`. Caddy mints a
certificate from its own local CA, so you get a warning the first time unless
you install that CA:

```sh
docker compose cp tls:/data/caddy/pki/authorities/local/root.crt .
```

If you have a real hostname, point it at the box and edit
`config/Caddyfile` — Caddy will get a public certificate automatically.

---

## Playing

Press **Connect**. That single click is what grants fullscreen, pointer lock,
keyboard lock and unmuted audio — browsers gate all four behind a user gesture,
which is why there is a button rather than an auto-start.

| Action | How |
|---|---|
| Move the camera | Push the pointer into the outer few pixels of the picture, or the arrow keys |
| Select units | Left click, or left-drag a box |
| Move / attack | Right click |
| Control groups | `Ctrl+1…9` to assign, `1…9` to recall — **needs Keyboard Lock**, see below |
| Zoom | Mouse wheel |
| Release the capture | `Ctrl+Alt+Q` — handled locally, never sent to the game |

The HUD badge in the top-left tells you what you actually got:

* `keyboard: full` — Keyboard Lock is active. `Ctrl+1…9` and `Escape` reach the
  game.
* `keyboard: partial` — no Keyboard Lock. `Ctrl+1…9` will switch browser tabs.
  Use Chromium, and leave the *Fullscreen + keyboard lock* option checked.

---

## How it fits together

```
  browser                                container
  ┌──────────────────────────┐           ┌───────────────────────────────────┐
  │ <video>  ◄── H.264/RTP ──┼── WebRTC ─┼─ webrtcbin ◄─ x264enc ◄─ ximagesrc │
  │                          │           │                            ▲      │
  │ RtsInput ──► JSON ───────┼──────────►│ XTEST ──► Xvfb :0 ─────────┘      │
  │            (datachannel, │           │                 ▲                 │
  │             WS fallback) │           │            openbox ─► wine game.dat│
  └──────────────────────────┘           │                        │  (DXVK)   │
                                         │  pulseaudio ◄──────────┘           │
                                         └───────────────────────────────────┘
```

One player at a time — there is one game process on one X display. A second
browser takes over and the first is dropped, which is also what makes reconnect
work: a reloading tab does not have to wait for the old socket to time out.

The whole GStreamer pipeline is built and torn down per peer. That is more
teardown than strictly necessary, but it means every reconnect starts from a
fresh keyframe instead of a grey rectangle.

### Why the input layer is not generic remote desktop

Four things about this game shaped it, all confirmed against the source in this
repository:

**The edge-scroll band is 3 pixels.**
`LookAtTranslator.cpp` sets `edgeScrollSize = 3`. On a 1600-wide frame that is
0.19% of the picture. Scale the stream into a browser window and naive
coordinate mapping essentially never produces column 0 or column 1599, so edge
scrolling silently does not work. The client therefore *snaps*: a pointer within
`EDGE_SNAP_PX` of the picture edge — or out in the letterbox entirely — is
pinned to the exact edge column. In pointer-lock mode the same effect falls out
of clamping the virtual cursor to `[0, W-1]`, so holding the mouse against the
edge keeps the camera moving.

**The mouse is Win32, the keyboard is DirectInput.**
`W3DGameClient::createMouse()` returns a `W3DMouse` (a `Win32Mouse`), which
consumes ordinary window messages with absolute client coordinates — so
absolute XTEST motion is exactly right. But `createKeyboard()` returns a
`DirectInputKeyboard`, and DirectInput reads **scancodes**. So the client sends
`KeyboardEvent.code` (a physical-position identifier) and never
`KeyboardEvent.key` (layout-dependent). A player on a Dvorak or AZERTY layout
gets the same physical keys the game expects.

**DirectInput is acquired `DISCL_FOREGROUND`.**
If the Wine window loses X input focus, every keystroke is silently dropped and
`WinMain.cpp` calls `TheAudio->loseFocus()` — video keeps flowing while input
and sound die, which looks exactly like a network fault. `focus-watchdog.sh`
makes that state unreachable.

**A stuck key is unrecoverable.**
A held `Ctrl` in an RTS turns every subsequent click into a control-group
reassignment; a held left button leaves a selection box growing forever. So
release-all fires on pointer-lock loss, window blur, tab hide, peer disconnect
and pipeline teardown, on both sides. The client additionally reconciles
modifier state against `ctrlKey`/`shiftKey`/`altKey`/`metaKey` on every key
event, because browsers routinely lose the `keyup` for a modifier released
while an OS overlay has focus.

### Networking, and why host mode

`network_mode: host` is the default deliberately. WebRTC negotiates ICE *host
candidates* from the addresses the container can see. On a bridge network those
are `172.x` addresses your browser cannot route to, so signalling completes
perfectly, both sides report "connected", and no video ever arrives. Host
networking makes the server's real address a valid candidate.

If you must use bridge networking: comment out `network_mode`, uncomment
`ports`, and expect to need a TURN server (`TURN_SERVER=` in `.env`).

### The Wine prefix

`setup-prefix.sh` is idempotent and runs on every start. It:

* creates the prefix (`win64` by default — the 32-bit game runs under WoW64 and
  DXVK's 32-bit DLLs go to `syswow64`);
* installs DXVK's `d3d8.dll` **and** `d3d9.dll` (DXVK's D3D8 is implemented on
  top of its own D3D9, so both are required) and writes a tuned `dxvk.conf`;
* writes the registry keys the retail binary looks for under
  `SOFTWARE\Electronic Arts\EA Games\Command and Conquer Generals Zero Hour`
  (`InstallPath`, `Language`, `UserDataLeafName`, `Version`) — in **both** the
  plain and `Wow6432Node` locations, because a 32-bit process on a win64 prefix
  is redirected. A fresh prefix has none of these, and `GlobalData.cpp` needs
  `UserDataLeafName` to find its user directory;
* pins the prefix to 96 DPI so nothing scales underneath the capture;
* seeds `Options.ini` with `Resolution = <W> <H>` so the first launch already
  matches the capture geometry instead of coming up at 800×600.

The prefix lives on a named volume, so settings, saves, replays and the DXVK
shader cache survive `docker compose down`. To start over:
`docker compose down -v`.

---

## What is verified and what is not

### Verified in a sandbox without Docker, a GPU, or the game

* Every shell script passes `bash -n`; `run.sh` was run end to end against a
  stubbed `docker` and a synthetic game directory, and produced a correct
  `.env`.
* `docker-compose.yml`, the Sunshine override, `apps.json`, `openbox-rc.xml`
  and `supervisord.conf` all parse.
* All three Python modules parse. `xinput.py` was unit-tested against a fake X
  display: keymap construction, coordinate clamping to `0`/`W-1`, button and
  wheel translation, keydown de-duplication, release-all, and message dispatch.
* `pipeline.py`'s pipeline description was generated and asserted against for
  all three encoder profiles and with audio on and off.
* `server.py`'s GStreamer-to-browser ICE URI translation was unit-tested
  (`stun://`, `turn://` with and without credentials, `turns://`, empty).
* `run.sh`'s game-argument merging was tested separately, including that
  `-xres`/`-yres` supplied through `GAME_ARGS` are dropped together with their
  values rather than leaving a stray numeric token, and the focus watchdog's
  three window-detection strategies were tested against a stubbed `xdotool`.
* All three JS files pass `node --check`. `input.js` was exercised in a
  synthetic DOM: `object-fit: contain` geometry, direct and pointer-locked
  coordinate mapping, edge snapping (including the letterbox), move coalescing
  and the flush-before-button ordering, wheel normalisation across all three
  `deltaMode` values, scancode identity, autorepeat suppression, modifier
  reconciliation, and the `Ctrl+Alt+Q` escape hatch.
* Every element id and asset path referenced by `app.js` and `index.html`
  resolves.
* Facts taken from the engine source in this repository rather than from
  memory: `edgeScrollSize = 3`; `-win`/`-xres`/`-yres`/`-quickstart` are
  available in **retail** builds; the mouse is `Win32Mouse` and the keyboard is
  `DirectInputKeyboard` acquired `DISCL_NONEXCLUSIVE|DISCL_FOREGROUND`; the
  registry paths and `Options.ini`'s `Resolution = <x> <y>` format.

### Not verified — nothing here has been run

* **The image has never been built.** No Docker daemon was available. Package
  names, the WineHQ repository layout for Ubuntu 24.04, and the DXVK release
  asset URL are all from documentation, not from a successful build.
* **The game has never been launched.** No install and no assets were present.
* **No frame has ever been captured, encoded or decoded.** The GStreamer
  pipeline has never been instantiated; element property names come from the
  upstream `webrtc-sendrecv` example and the plugin documentation.
* **No WebRTC session has ever been negotiated**, and the browser client has
  never been rendered — there was no browser in the environment. The UI is
  syntactically valid and structurally consistent, and that is all that can be
  claimed.
* The Sunshine comparison path is documentation and configuration only.

---

## What will break first

Roughly in order of how likely it is to bite.

**1. D3D8 under Wine at all.**
The single largest unknown. DXVK only gained D3D8 in 2.4 (the merged `d8vk`
work), it is implemented on top of DXVK's D3D9, and Zero Hour is exactly the
kind of 2003 fixed-function title that finds its edges — dxvk issue #4112 was
*this game*, menus dropping to ~15 fps. That one is fixed, but it is
representative.

*If the game renders nothing, crashes on startup, or the menus crawl:* switch
to `RENDERER=wined3d`. Wine's own D3D8→OpenGL path is fifteen years older and
much better travelled for this title, and against llvmpipe it is likely to be
**faster** than DXVK-on-lavapipe, because llvmpipe's OpenGL is far more mature
than lavapipe's Vulkan. Treat wined3d as the baseline and DXVK as the
optimisation.

**2. DXVK 3.x needs Vulkan 1.4; stock Ubuntu 24.04 lavapipe does not have it.**
This is why `DXVK_VERSION` defaults to `2.7.1`. If you set it to a 3.x release
with `GPU=none` and stock Mesa, DXVK will refuse to create a device and you
will get a black window. Either stay on 2.7.x, or build with `MESA_PPA=1`, or
use a real GPU.

**3. Wine 10's WoW64 layout versus a 32-bit game with 32-bit DXVK DLLs.**
Modern WineHQ builds are moving to new-WoW64, where there are no 32-bit Unix
libraries. That path is less travelled for old 32-bit D3D titles. Symptoms are
early crashes or DXVK never loading. Try `WINE_BRANCH=devel` or `staging`,
`WINE_SOURCE=distro`, or `WINEARCH=win32` (which needs a Wine build that still
supports pure 32-bit prefixes).

**4. Software encoding cost.**
`x264enc` at 1600×900/30 with `veryfast` needs real cores, and it is competing
with llvmpipe for them. If the stream is choppy while the game itself is fine,
drop `ENCODER_PRESET=ultrafast`, then `SCREEN_WIDTH/HEIGHT` to `1024x768`, then
`GAME_FPS` to 20. Add `-noshellmap` to `GAME_ARGS`: the animated main-menu map
is surprisingly expensive when software rendering.

**5. Capture latency, and where it actually goes.**
The floor is roughly: one game frame (33 ms at 30 fps) + one capture interval
(33 ms) + encode (5–30 ms software) + network + the browser's jitter buffer
(30–100 ms, and not something a page can set). Expect **80–150 ms** on a LAN
with software encoding — playable for skirmish, noticeably soft for anything
competitive. `ximagesrc` polling at a fixed rate rather than using damage
events costs a frame of latency and buys reliability; that is the trade this
phase wants. The single biggest remaining win is hardware encoding
(`GPU=dri`, `ENCODER=vaapi`).

**6. An invisible cursor.**
`ximagesrc show-pointer=true` composites the X cursor through XFIXES. If the
game draws its cursor into the D3D back buffer instead, it appears in the
capture anyway; if it uses a hardware cursor plane, it may not. If you have no
pointer, add `-winCursors` to `GAME_ARGS` to force Windows cursors.

**7. Focus.**
If keys do nothing but the mouse works, the game window has lost X input focus
and DirectInput's `DISCL_FOREGROUND` is dropping everything. Check
`logs/focus.err`.

**8. Aspect ratio.**
The Zero Hour UI was laid out for 4:3. 16:9 works and is what the default
1600×900 gives you, but some menu art stretches. Use `--size 1024x768` if that
bothers you.

---

## Troubleshooting

Logs are bind-mounted to `deploy/logs/`:

| File | Covers |
|---|---|
| `game.err` | Wine, DXVK, the game itself |
| `streamer.err` | Capture, encode, WebRTC negotiation, input |
| `xvfb.err` | The X server |
| `openbox.err`, `focus.err` | Window management and focus |
| `pulse.err` | Audio |

```sh
docker compose --env-file .env logs -f game     # everything, interleaved
docker compose exec game supervisorctl status   # which units are alive
docker compose exec game bash                   # poke around
```

### The page loads but the video stays black

1. Check the HUD. `connected` with `0fps` means media is not flowing; anything
   else means signalling did not finish.
2. Confirm secure context: `http://localhost` or `https://`, never
   `http://<ip>`. The overlay warns about this explicitly.
3. Confirm host networking. On a bridge network, ICE offers unreachable
   `172.x` candidates and this is exactly the symptom.
4. `grep -i 'ICE\|candidate' deploy/logs/streamer.err`.

### The stream works but the game window is missing or wrong size

`SCREEN_WIDTH`/`SCREEN_HEIGHT`, the game's `-xres`/`-yres` and the encoder must
all agree. If you changed them after the first run, `Options.ini` in the prefix
still has the old resolution — either change it in the game's own options
screen, or `docker compose down -v` and start clean.

### Edge scrolling does not work

Raise `EDGE_SNAP_PX` (try 8). If the camera instead runs away whenever you aim
near the border, lower it to 2. Remember the game's own band is 3 pixels; you
are widening the target, and there is a real trade between reachability and
accidental scrolling.

### `Ctrl+1…9` switches browser tabs

You do not have Keyboard Lock. Use Chromium, keep the *Fullscreen + keyboard
lock* option checked, and check the HUD reads `keyboard: full`. There is no
workaround in Firefox or Safari — the API does not exist there.

### Audio is silent

`docker compose exec game pactl list short sinks` should show `cnc_sink`.
Confirm the prefix has `HKCU\Software\Wine\Drivers` `Audio = pulse` (written by
`setup-prefix.sh`). Remember the game mutes itself when its window loses focus.

### Verifying DXVK is actually being used

Add `DXVK_HUD=version,fps,api` to the `game` service environment and restart.
If no overlay appears, the DLL overrides did not take and you are silently on
wined3d.

---

## Deliberate non-goals for Phase 1

* Multiple concurrent players in one container. One game, one X display, one
  peer. Multiplayer between humans is Zero Hour's own LAN/online path, which is
  a separate problem.
* Authentication. Anyone who can reach the port can play. Put it behind a
  tunnel, a VPN, or a reverse proxy with auth.
* Persistence beyond the Wine prefix volume.
* Any change to the game. The whole point is the stock retail binary.
