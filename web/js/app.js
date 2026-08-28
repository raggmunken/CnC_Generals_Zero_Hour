/*
 * Glue: wires StreamClient and RtsInput to the overlay and the HUD.
 */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const video        = $('video');
  const surface      = $('cursor-blocker');
  const overlay      = $('overlay');
  const statusLine   = $('status-line');
  const connectBtn   = $('connect-btn');
  const hud          = $('hud');
  const hudState     = $('hud-state');
  const hudRtt       = $('hud-rtt');
  const hudVideo     = $('hud-video');
  const hudKeyboard  = $('hud-keyboard');
  const optPointer   = $('opt-pointerlock');
  const optFull      = $('opt-fullscreen');
  const optAudio     = $('opt-audio');
  const optSens      = $('opt-sens');
  const sensValue    = $('sens-value');
  const secureWarn   = $('secure-warning');

  let engaged = false;

  // --------------------------------------------------------------- secure ctx
  // WebRTC, pointer lock and keyboard lock all require a secure context. Over
  // plain HTTP to a remote host, everything below fails in confusing ways, so
  // say so up front rather than letting the player debug an empty <video>.
  if (!window.isSecureContext) {
    secureWarn.hidden = false;
  }

  // ------------------------------------------------------------------ input
  const input = new RtsInput({
    video: video,
    surface: surface,
    send: (obj) => client.sendInput(obj),
    onNotice: (text) => notice(text),
  });

  // ----------------------------------------------------------------- client
  const client = new StreamClient({
    video: video,

    onHello: (msg) => {
      input.setGeometry(msg.width, msg.height, msg.edgeSnapPx);
      hudVideo.textContent = msg.width + '×' + msg.height + ' @' + msg.fps;
    },

    onState: (state, text) => {
      statusLine.textContent = text;
      statusLine.className = 'status' +
        (state === 'connected' ? ' ready' : (state === 'reconnecting' ? ' error' : ''));

      hudState.textContent = state;
      hudState.className = 'badge ' +
        (state === 'connected' ? 'ok' : (state === 'degraded' ? 'warn' : 'bad'));

      if (state === 'connected') {
        connectBtn.disabled = false;
        connectBtn.textContent = engaged ? 'Resume' : 'Connect';
        if (engaged) {
          // Recovered on our own after a blip: put the player straight back in
          // rather than making them click through the overlay again.
          hideOverlay();
        }
      } else {
        connectBtn.disabled = true;
        if (state === 'reconnecting' || state === 'connecting') {
          // Capture is dropped while the link is down so no key can stick, but
          // `engaged` is remembered so we can restore it automatically.
          input.release(false);
          showOverlay();
        }
      }
    },

    onStats: (s) => {
      hudRtt.textContent = s.rtt === null || s.rtt === undefined
        ? 'rtt —'
        : 'rtt ' + s.rtt.toFixed(0) + 'ms';
      hudRtt.className = 'badge ' +
        (s.rtt == null ? '' : (s.rtt < 60 ? 'ok' : (s.rtt < 150 ? 'warn' : 'bad')));

      const dims = (s.width && s.height) ? s.width + '×' + s.height : '—';
      const fps = s.fps ? Math.round(s.fps) + 'fps' : '—';
      hudVideo.textContent = dims + ' ' + fps;
    },

    onNotice: (text) => notice(text),
  });

  // --------------------------------------------------------------- overlay
  function showOverlay() {
    overlay.classList.add('visible');
    hud.hidden = false;
  }

  function hideOverlay() {
    overlay.classList.remove('visible');
    hud.hidden = false;
  }

  let noticeTimer = 0;
  function notice(text) {
    console.log('[client]', text);
    if (!engaged) return;
    hudState.textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      hudState.textContent = client.pc ? client.pc.connectionState : '—';
    }, 2500);
  }

  // --------------------------------------------------------------- controls
  optPointer.addEventListener('change', () => {
    input.wantPointerLock = optPointer.checked;
  });
  optFull.addEventListener('change', () => {
    input.wantFullscreen = optFull.checked;
  });
  optAudio.addEventListener('change', () => {
    video.muted = !optAudio.checked;
  });
  optSens.addEventListener('input', () => {
    input.sensitivity = parseFloat(optSens.value);
    sensValue.textContent = input.sensitivity.toFixed(2);
  });

  connectBtn.addEventListener('click', async () => {
    // Must run inside this user gesture: fullscreen, pointer lock, keyboard
    // lock and unmuted playback are all gesture-gated.
    video.muted = !optAudio.checked;
    try { await video.play(); } catch (e) { /* handled by the notice path */ }

    input.wantPointerLock = optPointer.checked;
    input.wantFullscreen = optFull.checked;
    input.sensitivity = parseFloat(optSens.value);

    const result = await input.engage();
    engaged = true;
    hideOverlay();

    if (result.keyboardLocked) {
      hudKeyboard.textContent = 'keyboard: full';
      hudKeyboard.className = 'badge ok';
    } else {
      hudKeyboard.textContent = 'keyboard: partial';
      hudKeyboard.className = 'badge warn';
      notice('no keyboard lock — Ctrl+1…9 will switch browser tabs');
    }
  });

  // Clicking the picture after the capture was dropped (alt-tab, an OS dialog,
  // a reconnect) re-engages without a trip through the overlay.
  surface.addEventListener('mousedown', () => {
    if (engaged && !input.active) {
      input.engage();
    }
  });

  // Leaving fullscreen is the player's way of asking for the menu back.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && engaged && input.wantFullscreen) {
      input.release(false);
      showOverlay();
      connectBtn.textContent = 'Resume';
    }
  });

  window.addEventListener('beforeunload', () => {
    input.release(false);
    client.stop();
  });

  // ------------------------------------------------------------------ start
  sensValue.textContent = parseFloat(optSens.value).toFixed(2);
  hud.hidden = false;
  client.start();
})();
