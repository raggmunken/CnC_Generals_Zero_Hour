/*
 * Transport: WebSocket signalling + RTCPeerConnection + input channel.
 *
 * Reconnect story, in order of how likely each failure is:
 *
 *   1. The websocket drops (host restart, wifi blip, laptop lid). Detected by
 *      onclose. Reconnect with jittered exponential backoff.
 *   2. ICE fails or stays disconnected. The websocket may still look fine, so
 *      it needs its own watchdog; after a grace period we tear the peer
 *      connection down and renegotiate from scratch.
 *   3. The stream stalls with everything still nominally "connected" -- the
 *      encoder wedged, the game crashed and supervisord is restarting it. Only
 *      detectable by watching frames actually arrive.
 *
 * All three converge on the same recovery: throw the RTCPeerConnection away
 * and negotiate a new one. The server builds a fresh GStreamer pipeline per
 * peer, so a reconnect always begins with a keyframe rather than a grey screen.
 */

(function (global) {
  'use strict';

  const RECONNECT_BASE_MS = 500;
  const RECONNECT_MAX_MS = 8000;
  const ICE_GRACE_MS = 6000;
  const STALL_TIMEOUT_MS = 8000;

  class StreamClient {
    constructor(opts) {
      this.video = opts.video;
      this.onState = opts.onState || function () {};
      this.onHello = opts.onHello || function () {};
      this.onStats = opts.onStats || function () {};
      this.onNotice = opts.onNotice || function () {};

      this.ws = null;
      this.pc = null;
      this.inputChannel = null;

      this.attempt = 0;
      this.stopped = false;
      this.reconnectTimer = 0;
      this.iceTimer = 0;
      this.statsTimer = 0;
      this.lastFrames = -1;
      this.lastFrameChange = 0;

      this.iceServers = [];
      this.pendingPings = new Map();
      this.pingSeq = 0;
      this.rtt = null;
    }

    // ------------------------------------------------------------ lifecycle
    start() {
      this.stopped = false;
      this._connect();
    }

    stop() {
      this.stopped = true;
      clearTimeout(this.reconnectTimer);
      this._teardown();
    }

    _connect() {
      this._teardown();
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = proto + '//' + location.host + '/ws';
      this.onState('connecting', 'Connecting to ' + location.host + '…');

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        this._scheduleReconnect('websocket: ' + err.message);
        return;
      }
      this.ws = ws;

      ws.onopen = () => {
        this.attempt = 0;
        this.onState('signalling', 'Negotiating stream…');
        // The peer connection is NOT built here. `hello` carries the ICE
        // servers this host is configured with, and building the connection
        // before it arrives would mean falling back to a hardcoded public STUN
        // address that an offline or firewalled host cannot reach -- ICE
        // gathering then stalls on a name it can never resolve.
      };
      ws.onmessage = (ev) => this._onSignal(ev.data);
      ws.onerror = () => { /* onclose always follows; report there */ };
      ws.onclose = (ev) => {
        if (this.stopped) return;
        this._scheduleReconnect(
          ev.code === 4000 ? 'replaced by another session' : 'connection closed'
        );
      };
    }

    _scheduleReconnect(reason) {
      if (this.stopped) return;
      this._teardown();
      this.attempt += 1;
      const backoff = Math.min(
        RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, this.attempt - 1)
      );
      // Jitter so a host restart does not have every client stampede at once.
      const delay = Math.round(backoff * (0.7 + Math.random() * 0.6));
      this.onState(
        'reconnecting',
        reason + ' — retrying in ' + (delay / 1000).toFixed(1) + 's (attempt ' +
        this.attempt + ')'
      );
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this._connect(), delay);
    }

    _teardown() {
      clearTimeout(this.iceTimer);
      clearInterval(this.statsTimer);
      this.iceTimer = 0;
      this.statsTimer = 0;
      this.inputChannel = null;
      this.lastFrames = -1;

      if (this.pc) {
        try { this.pc.ontrack = null; this.pc.onicecandidate = null; } catch (e) {}
        try { this.pc.close(); } catch (e) {}
        this.pc = null;
      }
      if (this.ws) {
        const ws = this.ws;
        this.ws = null;
        ws.onclose = null; ws.onmessage = null; ws.onerror = null; ws.onopen = null;
        try { ws.close(); } catch (e) {}
      }
    }

    // -------------------------------------------------------------- signals
    _sendSignal(obj) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj));
        return true;
      }
      return false;
    }

    async _onSignal(raw) {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }

      switch (msg.t) {
        case 'hello':
          this.iceServers = Array.isArray(msg.iceServers) ? msg.iceServers : [];
          this.onHello(msg);
          if (!this.pc) {
            this._startPeer();
            this._sendSignal({ t: 'start' });
          }
          break;

        case 'sdp':
          if (msg.type !== 'offer' || !this.pc) return;
          try {
            await this.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            this._sendSignal({ t: 'sdp', type: 'answer', sdp: answer.sdp });
          } catch (err) {
            this._scheduleReconnect('negotiation failed: ' + err.message);
          }
          break;

        case 'ice':
          if (!this.pc || !msg.candidate) return;
          try {
            await this.pc.addIceCandidate({
              candidate: msg.candidate,
              sdpMLineIndex: msg.sdpMLineIndex,
            });
          } catch (err) {
            // Candidates that arrive before the remote description are
            // expected and harmless.
          }
          break;

        case 'pong':
          this._resolvePing(msg.id);
          break;

        case 'error':
          this.onNotice('host: ' + msg.message);
          break;
      }
    }

    // ----------------------------------------------------------- peer setup
    _startPeer() {
      const config = {
        // Whatever the host was configured with, translated to RTCIceServer
        // form server-side. On a LAN or through a tunnel this is usually empty
        // and host candidates carry the day, which is the fastest path.
        iceServers: this.iceServers || [],
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
      };
      const pc = new RTCPeerConnection(config);
      this.pc = pc;

      pc.ontrack = (ev) => {
        if (this.video.srcObject !== ev.streams[0]) {
          this.video.srcObject = ev.streams[0];
          this.video.play().catch(() => {
            this.onNotice('autoplay blocked — click the picture');
          });
        }
      };

      pc.onicecandidate = (ev) => {
        if (ev.candidate) {
          this._sendSignal({
            t: 'ice',
            candidate: ev.candidate.candidate,
            sdpMLineIndex: ev.candidate.sdpMLineIndex,
          });
        }
      };

      // The host opens the input data channel, so it arrives here.
      pc.ondatachannel = (ev) => {
        if (ev.channel.label !== 'input') return;
        this.inputChannel = ev.channel;
        ev.channel.onopen = () => this.onNotice('input channel open');
        ev.channel.onclose = () => { this.inputChannel = null; };
        ev.channel.onmessage = (m) => {
          try {
            const msg = JSON.parse(m.data);
            if (msg.t === 'pong') this._resolvePing(msg.id);
          } catch (e) {}
        };
      };

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') {
          clearTimeout(this.iceTimer);
          this.iceTimer = 0;
          this.attempt = 0;
          this.lastFrameChange = performance.now();
          this.onState('connected', 'Streaming');
          this._startStats();
        } else if (s === 'failed') {
          this._scheduleReconnect('peer connection failed');
        } else if (s === 'disconnected') {
          // Do not panic immediately: a brief disconnect often recovers on its
          // own without a full renegotiation.
          this.onState('degraded', 'Connection unstable…');
          clearTimeout(this.iceTimer);
          this.iceTimer = setTimeout(() => {
            if (this.pc && this.pc.connectionState !== 'connected') {
              this._scheduleReconnect('connection did not recover');
            }
          }, ICE_GRACE_MS);
        }
      };
    }

    // ----------------------------------------------------------- monitoring
    _startStats() {
      clearInterval(this.statsTimer);
      this.statsTimer = setInterval(() => this._pollStats(), 1000);
      this._ping();
    }

    async _pollStats() {
      if (!this.pc) return;
      let report;
      try { report = await this.pc.getStats(); } catch (e) { return; }

      let frames = null, fps = null, width = null, height = null;
      let bytes = null, packetsLost = null, jitter = null;
      report.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          frames = s.framesDecoded;
          fps = s.framesPerSecond;
          bytes = s.bytesReceived;
          packetsLost = s.packetsLost;
          jitter = s.jitter;
        } else if (s.type === 'track' && s.frameWidth) {
          width = s.frameWidth; height = s.frameHeight;
        }
      });

      this.onStats({
        fps: fps, width: width, height: height, bytes: bytes,
        packetsLost: packetsLost, jitter: jitter, rtt: this.rtt,
      });

      // Stall detection: everything says "connected" but no new frames are
      // being decoded. This is what a wedged encoder or a crashed-and-
      // restarting game looks like from the browser.
      const now = performance.now();
      if (frames !== null && frames !== this.lastFrames) {
        this.lastFrames = frames;
        this.lastFrameChange = now;
      } else if (this.lastFrameChange && now - this.lastFrameChange > STALL_TIMEOUT_MS) {
        this._scheduleReconnect('video stalled');
        return;
      }

      this._ping();
    }

    _ping() {
      const id = ++this.pingSeq;
      const sent = performance.now();
      this.pendingPings.set(id, sent);
      // Prune anything that never came back, so the map cannot grow forever.
      if (this.pendingPings.size > 30) {
        const oldest = this.pendingPings.keys().next().value;
        this.pendingPings.delete(oldest);
      }
      this.sendInput({ t: 'ping', id: id });
    }

    _resolvePing(id) {
      const sent = this.pendingPings.get(id);
      if (sent === undefined) return;
      this.pendingPings.delete(id);
      const sample = performance.now() - sent;
      // Light smoothing; a single sample bounces too much to read.
      this.rtt = this.rtt === null ? sample : this.rtt * 0.7 + sample * 0.3;
    }

    // ---------------------------------------------------------------- input
    /**
     * Prefer the data channel (unordered, no retransmits) and fall back to the
     * websocket. TCP head-of-line blocking on a lost input packet is exactly
     * the failure that makes an RTS feel broken, so the datachannel is the
     * intended path; the websocket exists so input still works before it opens
     * and if it never does.
     */
    sendInput(obj) {
      const ch = this.inputChannel;
      if (ch && ch.readyState === 'open') {
        try {
          ch.send(JSON.stringify(obj));
          return true;
        } catch (e) { /* fall through to the websocket */ }
      }
      return this._sendSignal(obj);
    }
  }

  global.StreamClient = StreamClient;
})(window);
