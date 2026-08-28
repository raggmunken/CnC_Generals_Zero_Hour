#!/usr/bin/env python3
"""
Signalling + static file server + input sink for the browser client.

One process, one port. It serves:

    GET  /            the browser client (from web/)
    GET  /healthz     liveness for docker healthcheck
    GET  /config      stream geometry, so the client never guesses
    WS   /ws          signalling, and the fallback input channel

Exactly one player is supported at a time -- this is a single game process on a
single X display. A second connection takes over and the first is closed, which
is also what makes reconnect work: a browser that reloads after a network blip
does not have to wait for the old socket to time out.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
import threading

import gi

gi.require_version("Gst", "1.0")
from gi.repository import GLib, Gst  # noqa: E402

from aiohttp import WSMsgType, web  # noqa: E402

import xinput as input_mod  # noqa: E402
from pipeline import StreamPipeline  # noqa: E402

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-7s %(name)-9s %(message)s",
)
log = logging.getLogger("server")


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


class Config:
    def __init__(self) -> None:
        self.display = os.environ.get("DISPLAY", ":0")
        self.width = _env_int("SCREEN_WIDTH", 1600)
        self.height = _env_int("SCREEN_HEIGHT", 900)
        self.fps = _env_int("GAME_FPS", 30)
        self.port = _env_int("STREAM_PORT", 8080)
        self.encoder = os.environ.get("ENCODER", "x264")
        self.video_bitrate_kbps = _env_int("VIDEO_BITRATE_KBPS", 12000)
        self.audio_enabled = os.environ.get("AUDIO_ENABLED", "1") == "1"
        self.stun_server = os.environ.get("STUN_SERVER", "").strip()
        self.turn_server = os.environ.get("TURN_SERVER", "").strip()
        self.web_root = os.environ.get("WEB_ROOT", "/opt/cnc/web")
        sink = os.environ.get("PULSE_SINK", "cnc_sink")
        self.pulse_monitor = os.environ.get("PULSE_MONITOR", f"{sink}.monitor")
        # How far, in remote pixels, the client should snap the pointer to the
        # screen edge. LookAtTranslator's edgeScrollSize is 3px, which is far
        # too small to hit through a scaled <video>, so the client widens it.
        self.edge_snap_px = _env_int("EDGE_SNAP_PX", 4)


class Session:
    """One connected browser: its websocket, its pipeline, its input state."""

    def __init__(self, app: "App", ws: web.WebSocketResponse) -> None:
        self.app = app
        self.ws = ws
        self.pipeline: StreamPipeline | None = None
        self.closed = False

    # -- outbound ----------------------------------------------------------
    def send_soon(self, payload: dict) -> None:
        """Queue a message onto the asyncio loop from any thread."""
        if self.closed:
            return
        asyncio.run_coroutine_threadsafe(self._send(payload), self.app.loop)

    async def _send(self, payload: dict) -> None:
        if self.closed or self.ws.closed:
            return
        try:
            await self.ws.send_str(json.dumps(payload))
        except Exception as exc:  # pragma: no cover
            log.debug("websocket send failed: %s", exc)

    # -- pipeline callbacks (called from GStreamer threads) ----------------
    def _on_sdp(self, kind: str, sdp_text: str) -> None:
        self.send_soon({"t": "sdp", "type": kind, "sdp": sdp_text})

    def _on_ice(self, mline_index: int, candidate: str) -> None:
        self.send_soon(
            {"t": "ice", "candidate": candidate, "sdpMLineIndex": mline_index}
        )

    def _on_error(self, message: str) -> None:
        log.error("session error: %s", message)
        self.send_soon({"t": "error", "message": message})

    def _on_datachannel_message(self, text: str) -> None:
        # Runs on a GStreamer thread. The injector is thread-safe and this is
        # the lowest-latency path we have, so handle it here rather than
        # bouncing through the asyncio loop.
        try:
            msg = json.loads(text)
        except (TypeError, ValueError):
            return
        reply = input_mod.handle_message(self.app.injector, msg)
        if reply is not None and self.pipeline is not None:
            self.pipeline.send_datachannel(json.dumps(reply))

    # -- lifecycle ---------------------------------------------------------
    def start_stream(self) -> None:
        if self.pipeline is not None:
            return
        self.pipeline = StreamPipeline(
            self.app.cfg,
            on_sdp=self._on_sdp,
            on_ice=self._on_ice,
            on_datachannel_message=self._on_datachannel_message,
            on_error=self._on_error,
        )
        self.pipeline.start()

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        if self.pipeline is not None:
            self.pipeline.stop()
            self.pipeline = None
        # Never leave a key or a mouse button stuck down after a disconnect.
        self.app.injector.release_all()


class App:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.loop: asyncio.AbstractEventLoop | None = None
        self.session: Session | None = None
        self.injector = input_mod.InputInjector(cfg.display, cfg.width, cfg.height)
        self.glib_loop = GLib.MainLoop()
        self._glib_thread = threading.Thread(
            target=self.glib_loop.run, name="glib", daemon=True
        )

    def start_glib(self) -> None:
        self._glib_thread.start()

    # -- HTTP --------------------------------------------------------------
    async def handle_index(self, _request: web.Request) -> web.FileResponse:
        return web.FileResponse(os.path.join(self.cfg.web_root, "index.html"))

    async def handle_health(self, _request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "peer": self.session is not None})

    async def handle_config(self, _request: web.Request) -> web.Response:
        return web.json_response(
            {
                "width": self.cfg.width,
                "height": self.cfg.height,
                "fps": self.cfg.fps,
                "audio": self.cfg.audio_enabled,
                "edgeSnapPx": self.cfg.edge_snap_px,
            }
        )

    async def handle_ws(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=10, max_msg_size=1 << 20)
        await ws.prepare(request)

        # Take over from any previous player.
        if self.session is not None:
            old, self.session = self.session, None
            log.info("a new peer connected; dropping the previous one")
            old.close()
            try:
                await old.ws.close(code=4000, message=b"replaced")
            except Exception:
                pass

        session = Session(self, ws)
        self.session = session
        log.info("peer connected from %s", request.remote)

        await session._send(
            {
                "t": "hello",
                "width": self.cfg.width,
                "height": self.cfg.height,
                "fps": self.cfg.fps,
                "audio": self.cfg.audio_enabled,
                "edgeSnapPx": self.cfg.edge_snap_px,
            }
        )

        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    await self._on_ws_text(session, msg.data)
                elif msg.type == WSMsgType.ERROR:
                    log.warning("websocket error: %s", ws.exception())
                    break
        finally:
            log.info("peer disconnected")
            session.close()
            if self.session is session:
                self.session = None
        return ws

    async def _on_ws_text(self, session: Session, raw: str) -> None:
        try:
            msg = json.loads(raw)
        except (TypeError, ValueError):
            return
        t = msg.get("t")

        if t == "start":
            log.info("peer requested stream start")
            try:
                session.start_stream()
            except Exception as exc:
                log.exception("failed to start the pipeline")
                await session._send({"t": "error", "message": str(exc)})
        elif t == "sdp" and msg.get("type") == "answer":
            if session.pipeline is not None:
                session.pipeline.set_remote_answer(msg.get("sdp", ""))
        elif t == "ice":
            if session.pipeline is not None and msg.get("candidate"):
                session.pipeline.add_ice_candidate(
                    int(msg.get("sdpMLineIndex", 0)), msg["candidate"]
                )
        elif t in ("m", "md", "mu", "w", "kd", "ku", "reset", "ping"):
            # WebSocket input fallback, used until the data channel opens and
            # whenever it is unavailable.
            reply = input_mod.handle_message(self.injector, msg)
            if reply is not None:
                await session._send(reply)
        else:
            log.debug("unhandled websocket message %r", t)

    # -- wiring ------------------------------------------------------------
    def make_app(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/", self.handle_index)
        app.router.add_get("/healthz", self.handle_health)
        app.router.add_get("/config", self.handle_config)
        app.router.add_get("/ws", self.handle_ws)
        # Explicit static mounts rather than a catch-all at "/", which would
        # collide with the index route.
        for sub in ("js", "css", "assets"):
            path = os.path.join(self.cfg.web_root, sub)
            if os.path.isdir(path):
                app.router.add_static(f"/{sub}/", path, show_index=False)
        return app


def main() -> int:
    Gst.init(None)
    cfg = Config()

    log.info(
        "starting: display=%s %dx%d@%d encoder=%s audio=%s",
        cfg.display,
        cfg.width,
        cfg.height,
        cfg.fps,
        cfg.encoder,
        cfg.audio_enabled,
    )

    try:
        app = App(cfg)
    except Exception as exc:
        log.error("cannot initialise input injection on %s: %s", cfg.display, exc)
        return 1

    app.start_glib()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    app.loop = loop

    done = threading.Event()

    def _shutdown_resources() -> None:
        if done.is_set():
            return
        done.set()
        log.info("shutting down")
        if app.session is not None:
            app.session.close()
        app.injector.close()
        app.glib_loop.quit()

    # AppRunner rather than web.run_app(): run_app owns signal handling and
    # its `loop` argument has come and gone across aiohttp versions, and we
    # need this loop to be the same one the GStreamer threads post onto.
    async def serve() -> None:
        runner = web.AppRunner(app.make_app(), access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, host="0.0.0.0", port=cfg.port)
        await site.start()
        log.info("listening on http://0.0.0.0:%d", cfg.port)
        await stopped.wait()
        await runner.cleanup()

    stopped = asyncio.Event()

    def _stop() -> None:
        _shutdown_resources()
        loop.call_soon_threadsafe(stopped.set)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _stop)
        except NotImplementedError:  # pragma: no cover
            signal.signal(sig, lambda *_: _stop())

    try:
        loop.run_until_complete(serve())
    finally:
        _shutdown_resources()
        loop.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
