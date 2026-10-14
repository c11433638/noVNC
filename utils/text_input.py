"""Type Unicode into a local X11 desktop without using either selection."""

import ctypes
import time


class TextInputUnavailable(Exception):
    pass


class X11TextInput:
    def __init__(self, display_name):
        self.display = None
        try:
            self.x11 = ctypes.CDLL("libX11.so.6")
            self.xtest = ctypes.CDLL("libXtst.so.6")
        except OSError as exc:
            raise TextInputUnavailable() from exc
        pointer = ctypes.c_void_p
        integer = ctypes.c_int
        symbol = ctypes.c_ulong
        signatures = {
            "XOpenDisplay": ([ctypes.c_char_p], pointer),
            "XDisplayKeycodes": ([pointer, ctypes.POINTER(integer), ctypes.POINTER(integer)], integer),
            "XGetKeyboardMapping": ([pointer, ctypes.c_uint, integer, ctypes.POINTER(integer)], ctypes.POINTER(symbol)),
            "XChangeKeyboardMapping": ([pointer, integer, integer, ctypes.POINTER(symbol), integer], integer),
            "XQueryKeymap": ([pointer, ctypes.c_void_p], integer),
            "XSync": ([pointer, integer], integer),
            "XFree": ([pointer], integer),
            "XCloseDisplay": ([pointer], integer),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self.x11, name)
            function.argtypes, function.restype = arguments, result
        self.xtest.XTestFakeKeyEvent.argtypes = [pointer, ctypes.c_uint, integer, symbol]
        self.xtest.XTestQueryExtension.argtypes = [pointer] + [ctypes.POINTER(integer)] * 4
        self.display = self.x11.XOpenDisplay(display_name.encode())
        if not self.display:
            raise TextInputUnavailable()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.x11.XCloseDisplay(self.display)
        self.display = None

    def send(self, text):
        # Reserve an unused, released key. Explicit remapping avoids TigerVNC's
        # small, non-reclaimable pool of dynamically allocated Unicode keys.
        values = [ctypes.c_int() for _ in range(4)]
        if not self.xtest.XTestQueryExtension(self.display, *(ctypes.byref(value) for value in values)):
            raise TextInputUnavailable()
        minimum, maximum, width = (ctypes.c_int() for _ in range(3))
        self.x11.XDisplayKeycodes(self.display, ctypes.byref(minimum), ctypes.byref(maximum))
        mapping = self.x11.XGetKeyboardMapping(self.display, minimum.value,
                                              maximum.value - minimum.value + 1,
                                              ctypes.byref(width))
        if not mapping:
            raise TextInputUnavailable()
        pressed = ctypes.create_string_buffer(32)
        self.x11.XQueryKeymap(self.display, pressed)
        try:
            code = next((code for code in range(maximum.value, minimum.value - 1, -1)
                         if not pressed.raw[code // 8] & (1 << (code % 8)) and
                         not any(mapping[(code - minimum.value) * width.value + offset]
                                 for offset in range(width.value))), None)
        finally:
            self.x11.XFree(mapping)
        if code is None:
            raise TextInputUnavailable()
        symbols = (ctypes.c_ulong * width.value)()
        try:
            for character in text.replace("\r\n", "\n").replace("\r", "\n"):
                symbols[0] = {"\n": 0xff0d, "\t": 0xff09}.get(character) or (
                    ord(character) if ord(character) < 256 else 0x01000000 | ord(character))
                self.x11.XChangeKeyboardMapping(self.display, code, width.value, symbols, 1)
                self.x11.XSync(self.display, 0)
                # Toolkits must consume the mapping notification before the
                # key press, and the key press before the next remapping.
                time.sleep(0.025)
                self.xtest.XTestFakeKeyEvent(self.display, code, True, 0)
                self.xtest.XTestFakeKeyEvent(self.display, code, False, 0)
                self.x11.XSync(self.display, 0)
                time.sleep(0.025)
        finally:
            symbols[0] = 0
            self.x11.XChangeKeyboardMapping(self.display, code, width.value, symbols, 1)
            self.x11.XSync(self.display, 0)
