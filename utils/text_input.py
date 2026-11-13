"""Type Unicode into a local X11 desktop without using either selection."""

import ctypes
import time


# Spare keys remapped per batch, and the waits (seconds) around each batch
BATCH_KEYS = 8
MAPPING_DELAY = 0.025
KEY_DELAY = 0.002


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
            # Highest first: those are the least likely to be bound later.
            codes = [code for code in range(maximum.value, minimum.value - 1, -1)
                     if not pressed.raw[code // 8] & (1 << (code % 8)) and
                     not any(mapping[(code - minimum.value) * width.value + offset]
                             for offset in range(width.value))][:BATCH_KEYS]
        finally:
            self.x11.XFree(mapping)
        if not codes:
            raise TextInputUnavailable()
        symbols = (ctypes.c_ulong * width.value)()
        text = text.replace("\r\n", "\n").replace("\r", "\n")
        try:
            position = 0
            while position < len(text):
                # Map as many upcoming characters as there are spare keys, so
                # a whole batch shares one pair of waits instead of each
                # character paying for its own.
                assigned = {}
                end = position
                while end < len(text) and (text[end] in assigned or len(assigned) < len(codes)):
                    if text[end] not in assigned:
                        assigned[text[end]] = codes[len(assigned)]
                    end += 1
                for character, code in assigned.items():
                    symbols[0] = {"\n": 0xff0d, "\t": 0xff09}.get(character) or (
                        ord(character) if ord(character) < 256 else 0x01000000 | ord(character))
                    # A lone letter is read as its lower case with Shift for
                    # the upper case; name both levels so "A" stays "A".
                    if width.value > 1:
                        symbols[1] = symbols[0]
                    self.x11.XChangeKeyboardMapping(self.display, code, width.value, symbols, 1)
                self.x11.XSync(self.display, 0)
                # Toolkits must consume the mapping notification before the
                # key presses, and the key presses before the next remapping.
                time.sleep(MAPPING_DELAY)
                for character in text[position:end]:
                    self.xtest.XTestFakeKeyEvent(self.display, assigned[character], True, 0)
                    self.xtest.XTestFakeKeyEvent(self.display, assigned[character], False, 0)
                self.x11.XSync(self.display, 0)
                time.sleep(MAPPING_DELAY + KEY_DELAY * (end - position))
                position = end
        finally:
            symbols[0] = 0
            if width.value > 1:
                symbols[1] = 0
            for code in codes:
                self.x11.XChangeKeyboardMapping(self.display, code, width.value, symbols, 1)
            self.x11.XSync(self.display, 0)
