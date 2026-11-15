"""Fit application windows to a desktop that follows a phone's screen.

Windows keep their size when the desktop shrinks, leaving most of them off
screen. `fit` maximizes the ordinary ones and remembers which, so `restore`
can put exactly those back once the desktop is large again.
"""

import ctypes
import ctypes.util
import fcntl
import json
from pathlib import Path
import sys
import time

ANY = 0
ATOM = 4
WINDOW = 33
CLIENT_MESSAGE = 33
SUBSTRUCTURE = (1 << 20) | (1 << 19)
REMOVE, ADD = 0, 1


class ClientMessage(ctypes.Structure):
    _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong),
                ("send_event", ctypes.c_int), ("display", ctypes.c_void_p),
                ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong),
                ("format", ctypes.c_int), ("data", ctypes.c_long * 5)]


class Event(ctypes.Union):
    _fields_ = [("message", ClientMessage), ("pad", ctypes.c_long * 24)]


class WindowFit:
    def __init__(self, display):
        name = ctypes.util.find_library("X11")
        if not name:
            raise OSError("libX11 not found")
        x = self.x = ctypes.CDLL(name)
        x.XOpenDisplay.restype = ctypes.c_void_p
        x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        x.XDefaultRootWindow.restype = ctypes.c_ulong
        x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        x.XInternAtom.restype = ctypes.c_ulong
        x.XGetWindowProperty.argtypes = [
            ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_long,
            ctypes.c_long, ctypes.c_int, ctypes.c_ulong] + [ctypes.c_void_p] * 5
        x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int,
                                 ctypes.c_long, ctypes.c_void_p]
        x.XGetGeometry.argtypes = [ctypes.c_void_p, ctypes.c_ulong] + [ctypes.c_void_p] * 7
        x.XFree.argtypes = [ctypes.c_void_p]
        x.XFlush.argtypes = [ctypes.c_void_p]
        x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        x.XCloseDisplay.argtypes = [ctypes.c_void_p]
        x.XSetErrorHandler.restype = ctypes.c_void_p
        # A window can vanish between listing and asking; that is not fatal
        self.handler = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p,
                                        ctypes.c_void_p)(lambda *_: 0)
        x.XSetErrorHandler(self.handler)
        self.display = x.XOpenDisplay(display.encode())
        if not self.display:
            raise OSError("cannot open display")
        self.root = x.XDefaultRootWindow(self.display)

    def close(self):
        self.x.XCloseDisplay(self.display)

    def atom(self, name):
        return self.x.XInternAtom(self.display, name.encode(), 0)

    def values(self, window, name, kind):
        actual, fmt = ctypes.c_ulong(), ctypes.c_int()
        count, left = ctypes.c_ulong(), ctypes.c_ulong()
        data = ctypes.c_void_p()
        status = self.x.XGetWindowProperty(
            self.display, window, self.atom(name), 0, 4096, 0, kind,
            ctypes.byref(actual), ctypes.byref(fmt), ctypes.byref(count),
            ctypes.byref(left), ctypes.byref(data))
        if status != 0 or not data:
            return []
        try:
            if fmt.value != 32:
                return []
            return list(ctypes.cast(data, ctypes.POINTER(ctypes.c_ulong))[:count.value])
        finally:
            self.x.XFree(data)

    def size(self, window):
        root, border, depth = ctypes.c_ulong(), ctypes.c_uint(), ctypes.c_uint()
        left, top = ctypes.c_int(), ctypes.c_int()
        width, height = ctypes.c_uint(), ctypes.c_uint()
        if not self.x.XGetGeometry(
                self.display, window, ctypes.byref(root), ctypes.byref(left),
                ctypes.byref(top), ctypes.byref(width), ctypes.byref(height),
                ctypes.byref(border), ctypes.byref(depth)):
            return 0, 0
        return width.value, height.value

    def maximize(self, window, action):
        event = Event()
        message = event.message
        message.type = CLIENT_MESSAGE
        message.window = window
        message.message_type = self.atom("_NET_WM_STATE")
        message.format = 32
        message.data[0] = action
        message.data[1] = self.atom("_NET_WM_STATE_MAXIMIZED_VERT")
        message.data[2] = self.atom("_NET_WM_STATE_MAXIMIZED_HORZ")
        message.data[3] = 1
        self.x.XSendEvent(self.display, self.root, 0, SUBSTRUCTURE, ctypes.byref(event))

    def ordinary(self):
        """Yield (window, maximized) for the ordinary application windows."""
        normal = self.atom("_NET_WM_WINDOW_TYPE_NORMAL")
        skip = {self.atom("_NET_WM_STATE_SKIP_TASKBAR"),
                self.atom("_NET_WM_STATE_MODAL"),
                self.atom("_NET_WM_STATE_FULLSCREEN")}
        full = {self.atom("_NET_WM_STATE_MAXIMIZED_VERT"),
                self.atom("_NET_WM_STATE_MAXIMIZED_HORZ")}
        for window in self.values(self.root, "_NET_CLIENT_LIST", WINDOW):
            kinds = self.values(window, "_NET_WM_WINDOW_TYPE", ATOM)
            state = set(self.values(window, "_NET_WM_STATE", ATOM))
            if (kinds and normal not in kinds) or state & skip:
                continue
            if self.values(window, "WM_TRANSIENT_FOR", WINDOW):
                continue
            yield window, len(state & full) == 2

    def fit(self):
        """Maximize ordinary windows; returns the ones that were changed."""
        changed = [window for window, maximized in self.ordinary() if not maximized]
        for window in changed:
            self.maximize(window, ADD)
        self.x.XFlush(self.display)
        return changed

    def refresh(self, skip=()):
        """Maximize the maximized windows afresh.

        Some applications, Chromium among them, keep drawing at their old
        size when the desktop changes size underneath a maximized window.
        """
        windows = [window for window, maximized in self.ordinary()
                   if maximized and window not in skip]
        for window in windows:
            self.maximize(window, REMOVE)
        self.x.XSync(self.display, 0)
        time.sleep(0.8)
        for window in windows:
            self.maximize(window, ADD)
        self.x.XFlush(self.display)

    def restore(self, windows):
        present = set(self.values(self.root, "_NET_CLIENT_LIST", WINDOW))
        for window in windows:
            if window in present:
                self.maximize(window, REMOVE)
        self.x.XFlush(self.display)


def load(record):
    try:
        saved = json.loads(record.read_text())
        if isinstance(saved, list):
            saved = {"fitted": saved}
        return {"fitted": [int(item) for item in saved.get("fitted", [])],
                "screen": [int(item) for item in saved.get("screen", [])],
                "active": bool(saved.get("active"))}
    except (OSError, ValueError, TypeError, AttributeError):
        return {"fitted": [], "screen": [], "active": False}


def apply(display, record, mode, fit=None):
    """Run `fit` or `restore`, tracking fitted windows in the `record` file."""
    with open(record.with_name("window-fit.lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        saved = load(record)
        fitted = saved["fitted"]
        own = fit is None
        if own:
            fit = WindowFit(display)
        try:
            current = list(fit.size(fit.root))
            resized = current != saved["screen"]
            if mode == "fit":
                changed = fit.fit()
                fitted = sorted(set(fitted) | set(changed))
                if resized:
                    time.sleep(0.4)
                    fit.refresh()
            else:
                changed = fitted
                fit.restore(fitted)
                if resized:
                    fit.refresh(skip=fitted)
                fitted = []
        finally:
            if own:
                fit.close()
        record.write_text(json.dumps({"fitted": fitted, "screen": current,
                                      "active": mode == "fit"}))
        return len(changed)


def watch(display, record):
    """Keep windows fitted while a phone uses the desktop.

    The desktop is resized whenever the phone turns or reconnects, and the
    page cannot be relied on to say so: it may be in the background.
    """
    with open(record.with_name("window-fit.watch"), "a") as single:
        try:
            fcntl.flock(single, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        fit = WindowFit(display)
        size, changed = fit.size(fit.root), None
        while load(record)["active"]:
            time.sleep(0.5)
            now = fit.size(fit.root)
            if now != size:
                size, changed = now, time.monotonic()
            elif changed is not None and time.monotonic() - changed > 0.8:
                changed = None
                apply(display, record, "fit", fit)


if __name__ == "__main__" and len(sys.argv) == 4 and sys.argv[1] == "watch":
    watch(sys.argv[2], Path(sys.argv[3]))
