/*
 * RTS input mapping for the Generals Zero Hour web client.
 *
 * This is deliberately not a generic remote-desktop input layer. Four things
 * about this game drive the design:
 *
 *  1. EDGE SCROLLING. LookAtTranslator.cpp scrolls the camera when the cursor
 *     is inside `edgeScrollSize = 3` pixels of the window edge. Three pixels of
 *     a 1600-wide frame is under 0.2% of the picture; once the stream is
 *     letterboxed and scaled into a browser window, naive coordinate scaling
 *     will essentially never produce column 0 or column W-1, and edge scrolling
 *     silently does not work. So the client snaps a pointer that is near (or
 *     past) the edge of the rendered picture onto the exact edge column.
 *
 *  2. BOX SELECTION. A drag has to deliver its endpoints exactly. Positions are
 *     coalesced to one per animation frame for bandwidth, but every button
 *     event flushes the pending position first, so press and release always
 *     land where the player actually clicked.
 *
 *  3. CONTROL GROUPS. Ctrl+1..9 is reserved by Chromium for tab switching and
 *     cannot be preventDefault()ed by an ordinary page. The only way to get it
 *     is the Keyboard Lock API, which requires fullscreen. The client asks for
 *     it and reports honestly when it could not get it.
 *
 *  4. SCANCODES. The game's keyboard is DirectInput (DirectInputKeyboard), which
 *     reads physical scancodes. So we send KeyboardEvent.code (a physical key
 *     identifier) and never KeyboardEvent.key, which is layout-dependent.
 *
 * Everything else here is about denying the browser its default reflexes:
 * context menu, text selection, drag-and-drop, pinch zoom, overscroll.
 */

(function (global) {
  'use strict';

  // Held down locally, so we can always send a clean release-all.
  const MODIFIER_CODES = {
    ctrl:  ['ControlLeft', 'ControlRight'],
    shift: ['ShiftLeft', 'ShiftRight'],
    alt:   ['AltLeft', 'AltRight'],
    meta:  ['MetaLeft', 'MetaRight'],
  };

  class RtsInput {
    /**
     * @param {object} opts
     * @param {HTMLVideoElement} opts.video      element the stream renders into
     * @param {HTMLElement}      opts.surface    transparent hit-target on top
     * @param {function(object)} opts.send       transport callback
     * @param {function(string)} opts.onNotice   UI notifications
     */
    constructor(opts) {
      this.video = opts.video;
      this.surface = opts.surface;
      this.send = opts.send;
      this.onNotice = opts.onNotice || function () {};

      // Remote geometry; replaced by the server's `hello`.
      this.remoteW = 1600;
      this.remoteH = 900;
      this.edgeSnapPx = 4;

      this.sensitivity = 1;
      this.wantPointerLock = true;
      this.wantFullscreen = true;

      this.active = false;
      this.pointerLocked = false;
      this.keyboardLocked = false;

      // Virtual cursor in REMOTE pixels. In pointer-lock mode this is the
      // authority; in direct mode it mirrors the last mapped position.
      this.vx = this.remoteW >> 1;
      this.vy = this.remoteH >> 1;

      this.pendingMove = false;
      this.rafHandle = 0;
      this.keysDown = new Set();
      this.buttonsDown = new Set();
      this.wheelAccum = 0;
      this.wheelAccumX = 0;

      this._bind();
    }

    // ---------------------------------------------------------------- setup
    setGeometry(width, height, edgeSnapPx) {
      this.remoteW = width | 0;
      this.remoteH = height | 0;
      if (typeof edgeSnapPx === 'number') this.edgeSnapPx = edgeSnapPx;
      this.vx = Math.min(this.vx, this.remoteW - 1);
      this.vy = Math.min(this.vy, this.remoteH - 1);
    }

    _bind() {
      const on = (target, type, fn, opts) =>
        target.addEventListener(type, fn.bind(this), opts || false);

      // --- gesture denial ------------------------------------------------
      // Right-click is a movement/attack command in this game, so the context
      // menu must never appear. Bound on the document, not the surface, so a
      // right-drag that slips outside the video is covered too.
      const swallow = (e) => { if (this.active) { e.preventDefault(); } };
      document.addEventListener('contextmenu', swallow, false);
      document.addEventListener('selectstart', swallow, false);
      document.addEventListener('dragstart', swallow, false);
      // Safari pinch-zoom.
      ['gesturestart', 'gesturechange', 'gestureend'].forEach((t) =>
        document.addEventListener(t, swallow, { passive: false }));

      // --- pointer -------------------------------------------------------
      on(this.surface, 'mousemove', this._onMouseMove, { passive: true });
      on(this.surface, 'mousedown', this._onMouseDown);
      // Button release is bound on the window: releasing outside the surface
      // (a box-select drag that overshoots the picture) must still arrive, or
      // the button stays stuck down on the host.
      on(window, 'mouseup', this._onMouseUp);
      // { passive: false } so preventDefault actually suppresses page scroll
      // and ctrl+wheel pinch zoom. Camera zoom is on the wheel in-game.
      on(this.surface, 'wheel', this._onWheel, { passive: false });

      // --- keyboard ------------------------------------------------------
      on(window, 'keydown', this._onKeyDown, { capture: true });
      on(window, 'keyup', this._onKeyUp, { capture: true });

      // --- capture state --------------------------------------------------
      on(document, 'pointerlockchange', this._onPointerLockChange);
      on(document, 'pointerlockerror', this._onPointerLockError);
      on(document, 'fullscreenchange', this._onFullscreenChange);
      on(document, 'visibilitychange', this._onVisibilityChange);
      on(window, 'blur', this._onBlur);
    }

    // ------------------------------------------------------------- capture
    /** Enter game capture. MUST be called from a user gesture. */
    async engage() {
      this.active = true;

      if (this.wantFullscreen && document.documentElement.requestFullscreen) {
        try {
          await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        } catch (err) {
          this.onNotice('fullscreen refused: ' + err.message);
        }
      }

      // Keyboard Lock is what makes Ctrl+1..9, Ctrl+W and Escape reach the
      // game instead of the browser. It only works inside fullscreen and only
      // in Chromium today.
      if (this.wantFullscreen && navigator.keyboard && navigator.keyboard.lock) {
        try {
          await navigator.keyboard.lock();
          this.keyboardLocked = true;
        } catch (err) {
          this.keyboardLocked = false;
          this.onNotice('keyboard lock refused: ' + err.message);
        }
      } else {
        this.keyboardLocked = false;
      }

      if (this.wantPointerLock) {
        this._requestPointerLock();
      }
      return { keyboardLocked: this.keyboardLocked };
    }

    _requestPointerLock() {
      const el = this.surface;
      if (!el.requestPointerLock) return;
      try {
        // unadjustedMovement bypasses OS pointer acceleration, so a given hand
        // movement always maps to the same number of remote pixels. That
        // matters for muscle memory on unit selection.
        const p = el.requestPointerLock({ unadjustedMovement: true });
        if (p && p.catch) {
          p.catch(() => { try { el.requestPointerLock(); } catch (e) {} });
        }
      } catch (err) {
        try { el.requestPointerLock(); } catch (e) {}
      }
    }

    /** Leave capture. Always releases every held key and button. */
    release(exitFullscreen) {
      this.active = false;
      this.releaseAll();
      if (document.pointerLockElement) document.exitPointerLock();
      if (this.keyboardLocked && navigator.keyboard && navigator.keyboard.unlock) {
        try { navigator.keyboard.unlock(); } catch (e) {}
      }
      this.keyboardLocked = false;
      if (exitFullscreen && document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    }

    releaseAll() {
      this.keysDown.clear();
      this.buttonsDown.clear();
      this.send({ t: 'reset' });
    }

    // -------------------------------------------------- coordinate mapping
    /**
     * Rendered geometry of the video content inside its element.
     * object-fit: contain means the picture is letterboxed, so the element
     * rect is not the picture rect.
     */
    _contentRect() {
      const r = this.video.getBoundingClientRect();
      const scale = Math.min(r.width / this.remoteW, r.height / this.remoteH) || 1;
      const w = this.remoteW * scale;
      const h = this.remoteH * scale;
      return {
        left: r.left + (r.width - w) / 2,
        top: r.top + (r.height - h) / 2,
        width: w,
        height: h,
        scale: scale,
      };
    }

    /**
     * Snap-and-clamp into remote pixel space.
     *
     * The snap is the whole point: anything within `edgeSnapPx` of the picture
     * edge -- or outside it entirely, in the letterbox -- is pinned to the
     * exact edge column so the game's 3-pixel scroll band is reachable.
     */
    _snap(x, y) {
      const e = this.edgeSnapPx;
      const maxX = this.remoteW - 1;
      const maxY = this.remoteH - 1;
      x = x <= e ? 0 : (x >= maxX - e ? maxX : Math.round(x));
      y = y <= e ? 0 : (y >= maxY - e ? maxY : Math.round(y));
      return [x, y];
    }

    // ------------------------------------------------------------ handlers
    _onMouseMove(e) {
      if (!this.active) return;

      if (this.pointerLocked) {
        const scale = this._contentRect().scale;
        // Divide by the display scale so hand travel maps to the same picture
        // distance whether the stream is shown at native size or scaled down.
        const k = this.sensitivity / (scale || 1);
        this.vx += (e.movementX || 0) * k;
        this.vy += (e.movementY || 0) * k;
        // Clamping is the edge-scroll mechanism in locked mode: hold the mouse
        // against the edge and the virtual cursor sits on column 0 or W-1,
        // which is exactly what keeps the camera scrolling.
        this.vx = Math.max(0, Math.min(this.remoteW - 1, this.vx));
        this.vy = Math.max(0, Math.min(this.remoteH - 1, this.vy));
      } else {
        const c = this._contentRect();
        const px = (e.clientX - c.left) / (c.scale || 1);
        const py = (e.clientY - c.top) / (c.scale || 1);
        const snapped = this._snap(px, py);
        this.vx = snapped[0];
        this.vy = snapped[1];
      }
      this._scheduleMove();
    }

    _scheduleMove() {
      // One position per animation frame. The game runs at ~30fps and a 60Hz
      // flush is already twice what it can observe; sending every raw
      // mousemove would be pure overhead.
      if (this.pendingMove) return;
      this.pendingMove = true;
      this.rafHandle = requestAnimationFrame(() => this._flushMove());
    }

    _flushMove() {
      if (!this.pendingMove) return;
      this.pendingMove = false;
      const [x, y] = this._snap(this.vx, this.vy);
      this.send({ t: 'm', x: x, y: y });
    }

    _onMouseDown(e) {
      if (!this.active) {
        return; // the overlay owns the click that engages capture
      }
      e.preventDefault();
      // Flush first: press must land at the position the player sees, not at
      // wherever the last animation frame left the cursor.
      this._flushMove();
      this.buttonsDown.add(e.button);
      this.send({ t: 'md', b: e.button });

      // A click inside the picture after pointer lock was lost (alt-tab, an
      // OS dialog) should silently take the lock back rather than making the
      // player go through the overlay again.
      if (this.wantPointerLock && !this.pointerLocked) {
        this._requestPointerLock();
      }
    }

    _onMouseUp(e) {
      if (!this.active) return;
      e.preventDefault();
      this._flushMove();
      this.buttonsDown.delete(e.button);
      this.send({ t: 'mu', b: e.button });
    }

    _onWheel(e) {
      if (!this.active) return;
      e.preventDefault();          // stops page scroll and ctrl+wheel zoom
      // Normalise the three deltaModes to notches.
      const unit = e.deltaMode === 1 ? 3 : (e.deltaMode === 2 ? 1 : 100);
      // Drop the leftover fraction when the direction reverses. Carrying it
      // across a reversal makes the first zoom-out after a zoom-in feel like
      // it was ignored, which reads as input loss rather than as rounding.
      if (e.deltaY !== 0 && Math.sign(e.deltaY) !== Math.sign(this.wheelAccum)) {
        this.wheelAccum = 0;
      }
      if (e.deltaX !== 0 && Math.sign(e.deltaX) !== Math.sign(this.wheelAccumX)) {
        this.wheelAccumX = 0;
      }
      this.wheelAccum += e.deltaY / unit;
      this.wheelAccumX += e.deltaX / unit;
      const dy = Math.trunc(this.wheelAccum);
      const dx = Math.trunc(this.wheelAccumX);
      if (dy !== 0 || dx !== 0) {
        this.wheelAccum -= dy;
        this.wheelAccumX -= dx;
        this.send({ t: 'w', dx: dx, dy: dy });
      }
    }

    _onKeyDown(e) {
      if (!this.active) return;

      // Local escape hatch. Never forwarded, so it cannot be eaten by the game
      // and cannot leave the player trapped in a locked fullscreen tab.
      if (e.code === 'KeyQ' && e.ctrlKey && e.altKey) {
        e.preventDefault();
        this.release(true);
        this.onNotice('capture released');
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      // The game reads DirectInput key STATE, and X auto-repeat is disabled on
      // the host, so browser autorepeat would only ever produce duplicate
      // hotkey activations.
      if (e.repeat) return;

      this._reconcileModifiers(e);

      if (this.keysDown.has(e.code)) return;
      this.keysDown.add(e.code);
      this.send({ t: 'kd', c: e.code });
    }

    _onKeyUp(e) {
      if (!this.active) return;
      e.preventDefault();
      e.stopPropagation();
      if (!this.keysDown.has(e.code)) return;
      this.keysDown.delete(e.code);
      this.send({ t: 'ku', c: e.code });
      this._reconcileModifiers(e);
    }

    /**
     * Modifiers are the one class of key whose release the browser routinely
     * loses -- release Ctrl while a native menu or an OS overlay has focus and
     * no keyup ever arrives. A stuck Ctrl in an RTS means every subsequent
     * click reassigns a control group. Every key event carries the true
     * modifier state, so we reconcile against it on every event.
     */
    _reconcileModifiers(e) {
      const state = {
        ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey,
      };
      for (const name of Object.keys(MODIFIER_CODES)) {
        if (state[name]) continue;
        for (const code of MODIFIER_CODES[name]) {
          // Do not fight the event that is itself releasing this modifier.
          if (code === e.code) continue;
          if (this.keysDown.has(code)) {
            this.keysDown.delete(code);
            this.send({ t: 'ku', c: code });
          }
        }
      }
    }

    _onPointerLockChange() {
      this.pointerLocked = document.pointerLockElement === this.surface;
      if (!this.pointerLocked && this.active) {
        // Losing the lock usually means the OS took focus. Drop everything
        // held rather than leaving a key down on a host we can no longer see.
        this.releaseAll();
        this.onNotice('pointer released — click the picture to resume');
      }
    }

    _onPointerLockError() {
      this.pointerLocked = false;
      this.onNotice('pointer lock failed; falling back to direct mapping');
    }

    _onFullscreenChange() {
      if (!document.fullscreenElement) {
        this.keyboardLocked = false;
      }
    }

    _onVisibilityChange() {
      if (document.hidden && this.active) this.releaseAll();
    }

    _onBlur() {
      if (this.active) this.releaseAll();
    }

    // --------------------------------------------------------------- state
    describe() {
      return {
        active: this.active,
        pointerLocked: this.pointerLocked,
        keyboardLocked: this.keyboardLocked,
        keysDown: this.keysDown.size,
        buttonsDown: this.buttonsDown.size,
      };
    }
  }

  global.RtsInput = RtsInput;
})(window);
