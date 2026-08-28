"""
Input injection into the headless X server via XTEST.

Design notes that are specific to this game, not generic remote desktop:

* Zero Hour's mouse is Win32Mouse/W3DMouse (W3DGameClient::createMouse), i.e.
  it consumes ordinary WM_MOUSEMOVE / WM_*BUTTON* window messages with
  ABSOLUTE client coordinates. It is NOT DirectInput. So injecting absolute
  XTEST motion is exactly right, and there is no relative-motion path to fight.

* The keyboard IS DirectInput (W3DGameClient::createKeyboard ->
  DirectInputKeyboard), acquired DISCL_NONEXCLUSIVE|DISCL_FOREGROUND. That has
  two consequences:
    - DirectInput reads SCANCODES, so we must map the browser's physical
      `KeyboardEvent.code` (not `.key`) onto the matching physical X key.
      `code` is already a physical-position identifier, which makes this a
      clean 1:1 mapping.
    - DISCL_FOREGROUND means the game window must hold X input focus or every
      keystroke is silently dropped. That is what focus-watchdog.sh guarantees.

* LookAtTranslator's screen-edge scroll band is `edgeScrollSize = 3` pixels.
  Coordinates are therefore clamped to [0, W-1] x [0, H-1] rather than to
  something safely inside the screen: reaching column 0 or column W-1 is the
  entire mechanism by which the camera scrolls. The browser client is
  responsible for snapping near-edge positions outward; this module just
  refuses to lose the edge.
"""

from __future__ import annotations

import logging
import threading

from Xlib import X, XK, display as xdisplay

log = logging.getLogger("input")

# ---------------------------------------------------------------------------
# KeyboardEvent.code  ->  X keysym name
# ---------------------------------------------------------------------------
# Only physical keys. Anything not in this table is dropped with a debug log
# rather than guessed at, so a bad mapping can never produce a phantom command
# in the middle of a match.
CODE_TO_KEYSYM: dict[str, str] = {
    # Letters
    **{f"Key{c}": c.lower() for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ"},
    # Top-row digits. Control groups are Ctrl+1..0, so these matter a lot.
    **{f"Digit{d}": d for d in "0123456789"},
    # Function keys
    **{f"F{i}": f"F{i}" for i in range(1, 25)},
    # Navigation / editing
    "Escape": "Escape",
    "Backspace": "BackSpace",
    "Tab": "Tab",
    "Enter": "Return",
    "Space": "space",
    "Delete": "Delete",
    "Insert": "Insert",
    "Home": "Home",
    "End": "End",
    "PageUp": "Prior",
    "PageDown": "Next",
    "ArrowUp": "Up",
    "ArrowDown": "Down",
    "ArrowLeft": "Left",
    "ArrowRight": "Right",
    # Punctuation (US layout positions)
    "Minus": "minus",
    "Equal": "equal",
    "BracketLeft": "bracketleft",
    "BracketRight": "bracketright",
    "Backslash": "backslash",
    "Semicolon": "semicolon",
    "Quote": "apostrophe",
    "Backquote": "grave",
    "Comma": "comma",
    "Period": "period",
    "Slash": "slash",
    "IntlBackslash": "less",
    # Modifiers -- both sides, because the game reads scancodes and some
    # hotkeys are position-sensitive.
    "ShiftLeft": "Shift_L",
    "ShiftRight": "Shift_R",
    "ControlLeft": "Control_L",
    "ControlRight": "Control_R",
    "AltLeft": "Alt_L",
    "AltRight": "Alt_R",
    "MetaLeft": "Super_L",
    "MetaRight": "Super_R",
    "CapsLock": "Caps_Lock",
    # Numpad. Zero Hour's default camera and control-group bindings use it.
    "Numpad0": "KP_Insert",
    "Numpad1": "KP_End",
    "Numpad2": "KP_Down",
    "Numpad3": "KP_Next",
    "Numpad4": "KP_Left",
    "Numpad5": "KP_Begin",
    "Numpad6": "KP_Right",
    "Numpad7": "KP_Home",
    "Numpad8": "KP_Up",
    "Numpad9": "KP_Prior",
    "NumpadDecimal": "KP_Delete",
    "NumpadAdd": "KP_Add",
    "NumpadSubtract": "KP_Subtract",
    "NumpadMultiply": "KP_Multiply",
    "NumpadDivide": "KP_Divide",
    "NumpadEnter": "KP_Enter",
    "NumLock": "Num_Lock",
    "ScrollLock": "Scroll_Lock",
    "Pause": "Pause",
    "PrintScreen": "Print",
}

# Browser MouseEvent.button -> X button number.
BUTTON_MAP = {0: 1, 1: 2, 2: 3, 3: 8, 4: 9}

# Wheel directions -> X buttons.
WHEEL_UP, WHEEL_DOWN, WHEEL_LEFT, WHEEL_RIGHT = 4, 5, 6, 7


class InputInjector:
    """Thread-safe XTEST injector with hard release-all semantics."""

    def __init__(self, display_name: str, width: int, height: int):
        self.display_name = display_name
        self.width = width
        self.height = height
        self._lock = threading.Lock()
        self._d = xdisplay.Display(display_name)
        if not self._d.has_extension("XTEST"):
            raise RuntimeError(f"X server {display_name} has no XTEST extension")

        self._keycodes: dict[str, int] = {}
        self._unmapped: set[str] = set()
        self._build_keymap()

        # Everything currently held down, so we can always get back to a clean
        # slate. A stuck Ctrl or a stuck left button after a disconnect is the
        # single most destructive failure mode for an RTS.
        self._keys_down: set[str] = set()
        self._buttons_down: set[int] = set()
        self._x = width // 2
        self._y = height // 2

    # -- setup -------------------------------------------------------------
    def _build_keymap(self) -> None:
        missing = []
        for code, keysym_name in CODE_TO_KEYSYM.items():
            keysym = XK.string_to_keysym(keysym_name)
            if keysym == 0:
                missing.append((code, keysym_name))
                continue
            keycode = self._d.keysym_to_keycode(keysym)
            if keycode == 0:
                missing.append((code, keysym_name))
                continue
            self._keycodes[code] = keycode
        if missing:
            log.warning(
                "%d browser key codes have no X keycode in this server's keymap "
                "and will be ignored: %s",
                len(missing),
                ", ".join(f"{c}({k})" for c, k in missing[:20]),
            )
        log.info("keymap ready: %d codes mapped", len(self._keycodes))

    # -- primitives --------------------------------------------------------
    def _fake(self, event_type, detail=0, x=0, y=0) -> None:
        self._d.xtest_fake_input(event_type, detail, x=x, y=y)

    # -- mouse -------------------------------------------------------------
    def move_abs(self, x: int, y: int) -> None:
        """Absolute move, clamped to the screen INCLUDING its edge columns."""
        x = 0 if x < 0 else (self.width - 1 if x >= self.width else int(x))
        y = 0 if y < 0 else (self.height - 1 if y >= self.height else int(y))
        with self._lock:
            if x == self._x and y == self._y:
                return
            self._x, self._y = x, y
            self._fake(X.MotionNotify, 0, x=x, y=y)
            self._d.sync()

    def button(self, browser_button: int, down: bool) -> None:
        btn = BUTTON_MAP.get(browser_button)
        if btn is None:
            log.debug("ignoring unknown mouse button %s", browser_button)
            return
        with self._lock:
            if down:
                self._buttons_down.add(btn)
                self._fake(X.ButtonPress, btn)
            else:
                self._buttons_down.discard(btn)
                self._fake(X.ButtonRelease, btn)
            self._d.sync()

    def wheel(self, dx: int, dy: int) -> None:
        """One click per notch. Zero Hour maps the wheel to camera zoom."""
        with self._lock:
            for _ in range(min(abs(dy), 10)):
                btn = WHEEL_UP if dy < 0 else WHEEL_DOWN
                self._fake(X.ButtonPress, btn)
                self._fake(X.ButtonRelease, btn)
            for _ in range(min(abs(dx), 10)):
                btn = WHEEL_LEFT if dx < 0 else WHEEL_RIGHT
                self._fake(X.ButtonPress, btn)
                self._fake(X.ButtonRelease, btn)
            self._d.sync()

    # -- keyboard ----------------------------------------------------------
    def key(self, code: str, down: bool) -> None:
        keycode = self._keycodes.get(code)
        if keycode is None:
            if code not in self._unmapped:
                self._unmapped.add(code)
                log.debug("no X keycode for browser code %r; ignoring", code)
            return
        with self._lock:
            if down:
                # Idempotent: a duplicate keydown (browser autorepeat that
                # slipped through, or a resend after reconnect) must not queue
                # a second press the game could see as a double hotkey.
                if code in self._keys_down:
                    return
                self._keys_down.add(code)
                self._fake(X.KeyPress, keycode)
            else:
                self._keys_down.discard(code)
                self._fake(X.KeyRelease, keycode)
            self._d.sync()

    # -- safety ------------------------------------------------------------
    def release_all(self) -> None:
        """Release every held key and button.

        Called on pointer-lock loss, window blur, peer disconnect and stream
        teardown. Without it a disconnect mid-drag leaves the left button held
        in the X server forever and the game becomes unplayable until restart.
        """
        with self._lock:
            for code in list(self._keys_down):
                kc = self._keycodes.get(code)
                if kc:
                    self._fake(X.KeyRelease, kc)
            self._keys_down.clear()
            for btn in list(self._buttons_down):
                self._fake(X.ButtonRelease, btn)
            self._buttons_down.clear()
            self._d.sync()
        log.info("released all held input")

    def close(self) -> None:
        try:
            self.release_all()
        finally:
            try:
                self._d.close()
            except Exception:  # pragma: no cover - teardown best effort
                pass


# ---------------------------------------------------------------------------
# Message dispatch
# ---------------------------------------------------------------------------
def handle_message(injector: InputInjector, msg: dict) -> dict | None:
    """Apply one input message. Returns a reply dict, or None.

    Wire format (JSON, one object per message):
        {"t":"m",  "x":int, "y":int}        absolute pointer move
        {"t":"md", "b":int}                 mouse button down (browser button)
        {"t":"mu", "b":int}                 mouse button up
        {"t":"w",  "dx":int, "dy":int}      wheel, in notches
        {"t":"kd", "c":"KeyA"}              key down  (KeyboardEvent.code)
        {"t":"ku", "c":"KeyA"}              key up
        {"t":"reset"}                       release everything
        {"t":"ping","id":int}               latency probe
    """
    t = msg.get("t")
    if t == "m":
        injector.move_abs(int(msg.get("x", 0)), int(msg.get("y", 0)))
    elif t == "md":
        injector.button(int(msg.get("b", 0)), True)
    elif t == "mu":
        injector.button(int(msg.get("b", 0)), False)
    elif t == "w":
        injector.wheel(int(msg.get("dx", 0)), int(msg.get("dy", 0)))
    elif t == "kd":
        code = msg.get("c")
        if isinstance(code, str):
            injector.key(code, True)
    elif t == "ku":
        code = msg.get("c")
        if isinstance(code, str):
            injector.key(code, False)
    elif t == "reset":
        injector.release_all()
    elif t == "ping":
        return {"t": "pong", "id": msg.get("id")}
    else:
        log.debug("unknown input message type %r", t)
    return None
