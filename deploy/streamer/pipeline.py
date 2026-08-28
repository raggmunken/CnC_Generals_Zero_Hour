"""
Capture -> encode -> WebRTC, built on GStreamer's webrtcbin.

One pipeline instance per connected browser. Building and tearing down the
whole pipeline per peer is deliberate: it is far less code than dynamically
re-linking webrtcbin's pads, ximagesrc restarts in milliseconds, and it means
every reconnect starts from a fresh IDR frame instead of a grey screen waiting
for the next keyframe.

The negotiation direction is server-offers / browser-answers, matching the
upstream gst-examples webrtc-sendrecv reference.
"""

from __future__ import annotations

import logging
import os

import gi

gi.require_version("Gst", "1.0")
gi.require_version("GstWebRTC", "1.0")
gi.require_version("GstSdp", "1.0")
from gi.repository import Gst, GstSdp, GstWebRTC  # noqa: E402

log = logging.getLogger("pipeline")


# ---------------------------------------------------------------------------
# Encoder profiles
# ---------------------------------------------------------------------------
# H.264 constrained-baseline is forced on every path. It is the only profile
# every WebRTC implementation (including Firefox's bundled OpenH264) is
# guaranteed to decode, and Phase 1 is about the delivery concept working at
# all rather than squeezing quality.
#
# Only the x264 path is expected to work without host-specific setup. vaapi and
# nvenc are wired up because they are one env var away, but they need the
# matching /dev/dri or NVIDIA runtime and are untested here.
def _video_encoder(encoder: str, bitrate_kbps: int, fps: int) -> str:
    if encoder == "vaapi":
        return (
            f"vah264enc bitrate={bitrate_kbps} rate-control=cbr "
            f"key-int-max={fps * 2} b-frames=0 ref-frames=1 "
            "! video/x-h264,profile=constrained-baseline"
        )
    if encoder == "nvenc":
        return (
            f"nvh264enc bitrate={bitrate_kbps} preset=low-latency-hq "
            f"rc-mode=cbr gop-size={fps * 2} zerolatency=true bframes=0 "
            "! video/x-h264,profile=constrained-baseline"
        )
    # Software default.
    #   tune=zerolatency  : no lookahead, no frame reordering
    #   speed-preset      : veryfast is the practical floor for 1600x900@30 on
    #                       a few cores; drop to ultrafast if the CPU is the
    #                       bottleneck (see ENCODER_PRESET)
    #   key-int-max=fps*2 : a keyframe every ~2s bounds recovery after loss
    #   sliced-threads    : threads that do not add a frame of latency each
    preset = os.environ.get("ENCODER_PRESET", "veryfast")
    return (
        f"x264enc tune=zerolatency speed-preset={preset} "
        f"bitrate={bitrate_kbps} key-int-max={fps * 2} "
        "bframes=0 b-adapt=false sliced-threads=true "
        "byte-stream=false aud=false "
        "! video/x-h264,profile=constrained-baseline"
    )


class StreamPipeline:
    """Owns one GStreamer pipeline and its webrtcbin, for one peer."""

    VIDEO_PT = 96
    AUDIO_PT = 97

    def __init__(self, cfg, on_sdp, on_ice, on_datachannel_message, on_error):
        self.cfg = cfg
        self.on_sdp = on_sdp
        self.on_ice = on_ice
        self.on_datachannel_message = on_datachannel_message
        self.on_error = on_error
        self.pipe: Gst.Pipeline | None = None
        self.webrtc = None
        self.datachannel = None
        self._bus_watch_id = None

    # -- pipeline description ---------------------------------------------
    def _describe(self) -> str:
        c = self.cfg

        webrtc_props = [
            "webrtcbin name=sendrecv",
            "latency=0",
            "bundle-policy=max-bundle",
        ]
        if c.stun_server:
            webrtc_props.append(f"stun-server={c.stun_server}")
        if c.turn_server:
            webrtc_props.append(f"turn-server={c.turn_server}")

        # ximagesrc notes:
        #   use-damage=false -- damage-based capture skips frames whose damage
        #     events Wine/DXVK do not emit reliably; a fixed-rate full grab is
        #     the boring option that always works.
        #   show-pointer=true -- composites the X cursor via XFIXES. Zero Hour
        #     draws a Windows cursor (GlobalData m_winCursors defaults TRUE), so
        #     without this the player has no pointer at all.
        video = (
            f"ximagesrc display-name={c.display} use-damage=false "
            f"show-pointer=true "
            f"! video/x-raw,framerate={c.fps}/1 "
            f"! queue max-size-buffers=2 leaky=downstream "
            f"! videoconvert n-threads=4 "
            f"! video/x-raw,format=I420 "
            f"! {_video_encoder(c.encoder, c.video_bitrate_kbps, c.fps)} "
            # aggregate-mode=zero-latency + config-interval=-1 is what the
            # upstream GStreamer webrtc example uses for browser interop: SPS
            # and PPS are repeated in-band with every IDR so a late or
            # reconnecting decoder can start immediately.
            f"! rtph264pay aggregate-mode=zero-latency config-interval=-1 pt={self.VIDEO_PT} "
            f"! queue max-size-time=100000000 "
            f"! application/x-rtp,media=video,encoding-name=H264,payload={self.VIDEO_PT} "
            f"! sendrecv."
        )

        parts = [" ".join(webrtc_props), video]

        if c.audio_enabled:
            audio = (
                f"pulsesrc device={c.pulse_monitor} provide-clock=false "
                f"! audio/x-raw,rate=48000,channels=2 "
                f"! queue max-size-time=50000000 leaky=downstream "
                f"! audioconvert ! audioresample "
                f"! opusenc bitrate=96000 frame-size=10 "
                f"audio-type=restricted-lowdelay perfect-timestamp=true "
                f"! rtpopuspay pt={self.AUDIO_PT} "
                f"! queue max-size-time=50000000 "
                f"! application/x-rtp,media=audio,encoding-name=OPUS,payload={self.AUDIO_PT} "
                f"! sendrecv."
            )
            parts.append(audio)

        return "\n".join(parts)

    # -- lifecycle ---------------------------------------------------------
    def start(self) -> None:
        desc = self._describe()
        log.info("pipeline:\n%s", desc)
        self.pipe = Gst.parse_launch(desc)

        bus = self.pipe.get_bus()
        bus.add_signal_watch()
        bus.connect("message", self._on_bus_message)

        self.webrtc = self.pipe.get_by_name("sendrecv")
        self.webrtc.connect("on-negotiation-needed", self._on_negotiation_needed)
        self.webrtc.connect("on-ice-candidate", self._on_ice_candidate)
        self.webrtc.connect(
            "notify::ice-connection-state", self._on_ice_connection_state
        )

        # webrtcbin only builds its SCTP/DTLS objects once the element leaves
        # NULL, and create-data-channel asserts on a bin it considers closed.
        # READY is enough to initialise it and, unlike PLAYING, does not fire
        # on-negotiation-needed -- so the channel still makes it into the first
        # offer below.
        self.pipe.set_state(Gst.State.READY)

        # Create the input data channel BEFORE negotiation so it lands in the
        # first offer. ordered=false + maxRetransmits=0 makes it behave like
        # UDP: a lost mouse position is worthless a frame later, and head-of-
        # line blocking on a dropped packet is exactly what ruins an RTS.
        # Built from a string rather than set_value() calls so the GValue
        # types are unambiguous across PyGObject versions.
        try:
            opts = Gst.Structure.new_from_string(
                "options, ordered=(boolean)false, max-retransmits=(int)0;"
            )
        except Exception:  # pragma: no cover
            opts = None
        try:
            self.datachannel = self.webrtc.emit("create-data-channel", "input", opts)
        except Exception as exc:  # pragma: no cover
            log.warning("create-data-channel failed (%s); WebSocket input only", exc)
            self.datachannel = None

        if self.datachannel is not None:
            self.datachannel.connect("on-open", lambda _dc: log.info("datachannel open"))
            self.datachannel.connect("on-close", lambda _dc: log.info("datachannel closed"))
            self.datachannel.connect(
                "on-error", lambda _dc, err: log.warning("datachannel error: %s", err)
            )
            self.datachannel.connect(
                "on-message-string",
                lambda _dc, text: self.on_datachannel_message(text),
            )
        else:
            log.warning("no input data channel; falling back to WebSocket input")

        # Send-only: the browser has no camera or microphone to give us, and
        # asking for one makes some browsers surface a permission prompt.
        self._set_send_only()

        self.pipe.set_state(Gst.State.PLAYING)

    def _set_send_only(self) -> None:
        direction = GstWebRTC.WebRTCRTPTransceiverDirection.SENDONLY
        for i in range(2 if self.cfg.audio_enabled else 1):
            try:
                trans = self.webrtc.emit("get-transceiver", i)
                if trans is not None:
                    trans.set_property("direction", direction)
            except Exception as exc:  # pragma: no cover
                log.debug("could not set transceiver %d sendonly: %s", i, exc)

    def stop(self) -> None:
        if self.pipe is not None:
            try:
                self.pipe.set_state(Gst.State.NULL)
            except Exception:  # pragma: no cover
                pass
            self.pipe = None
        self.webrtc = None
        self.datachannel = None

    def send_datachannel(self, text: str) -> bool:
        if self.datachannel is None:
            return False
        try:
            self.datachannel.emit("send-string", text)
            return True
        except Exception:
            return False

    # -- negotiation -------------------------------------------------------
    def _on_negotiation_needed(self, _element) -> None:
        log.info("negotiation needed; creating offer")
        promise = Gst.Promise.new_with_change_func(self._on_offer_created, None, None)
        self.webrtc.emit("create-offer", None, promise)

    def _on_offer_created(self, promise, _a, _b) -> None:
        if promise.wait() != Gst.PromiseResult.REPLIED:
            self.on_error("create-offer did not reply")
            return
        reply = promise.get_reply()
        offer = reply.get_value("offer")
        p = Gst.Promise.new()
        self.webrtc.emit("set-local-description", offer, p)
        p.interrupt()
        self.on_sdp("offer", offer.sdp.as_text())

    def set_remote_answer(self, sdp_text: str) -> None:
        ok, sdpmsg = GstSdp.SDPMessage.new_from_text(sdp_text)
        if ok != GstSdp.SDPResult.OK:
            self.on_error("could not parse the browser's SDP answer")
            return
        answer = GstWebRTC.WebRTCSessionDescription.new(
            GstWebRTC.WebRTCSDPType.ANSWER, sdpmsg
        )
        p = Gst.Promise.new()
        self.webrtc.emit("set-remote-description", answer, p)
        p.interrupt()
        log.info("remote answer applied")

    def add_ice_candidate(self, mline_index: int, candidate: str) -> None:
        self.webrtc.emit("add-ice-candidate", mline_index, candidate)

    def _on_ice_candidate(self, _element, mline_index, candidate) -> None:
        self.on_ice(mline_index, candidate)

    def _on_ice_connection_state(self, _element, _pspec) -> None:
        state = self.webrtc.get_property("ice-connection-state")
        log.info("ICE connection state: %s", state.value_nick)
        if state.value_nick in ("failed", "closed"):
            self.on_error(f"ICE {state.value_nick}")

    # -- bus ---------------------------------------------------------------
    def _on_bus_message(self, _bus, message) -> None:
        t = message.type
        if t == Gst.MessageType.ERROR:
            err, debug = message.parse_error()
            log.error("gstreamer error: %s (%s)", err, debug)
            self.on_error(str(err))
        elif t == Gst.MessageType.WARNING:
            err, debug = message.parse_warning()
            log.warning("gstreamer warning: %s (%s)", err, debug)
        elif t == Gst.MessageType.EOS:
            log.error("gstreamer EOS -- capture ended unexpectedly")
            self.on_error("end of stream")
        elif t == Gst.MessageType.LATENCY and self.pipe is not None:
            self.pipe.recalculate_latency()
