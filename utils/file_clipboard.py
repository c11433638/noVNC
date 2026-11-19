"""Read and publish file selections on the local X11 desktop."""

import base64
import ctypes as C
import hashlib
import json
import os
from pathlib import Path
import select
import subprocess
import sys
import tempfile


GNOME_FILES = b"x-special/gnome-copied-files"
URI_LIST = b"text/uri-list"
IMAGE_PNG = b"image/png"
# Marks selections published for the browser, so they are not announced back.
ORIGIN = b"application/x-novnc-origin"
TEXT_TARGETS = {b"UTF8_STRING", b"STRING", b"TEXT", b"text/plain", b"text/plain;charset=utf-8"}
MAX_SELECTION_BYTES = 512 * 1024
MAX_IMAGE_BYTES = 64 * 1024 * 1024
TIMEOUT = 5
IMAGE_TIMEOUT = 30
WATCH_SECONDS = 20


class ClipboardUnavailable(Exception):
    pass


def desktop_selection(display, uris=None, image=None, media_type="image/png"):
    env = dict(os.environ, DISPLAY=display, GDK_BACKEND="x11")
    args = [sys.executable, str(Path(__file__).resolve())]
    try:
        if uris is None:
            return subprocess.run(args + ["read"], env=env, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, check=True, timeout=TIMEOUT).stdout

        # The X11 owner must stay alive after the HTTP response. Wait for
        # confirmation that it owns the selection before reporting success.
        with tempfile.TemporaryFile() as selection:
            selection.write(b"\n".join(uris))
            selection.seek(0)
            owner = subprocess.Popen(args + ["write"] + ([str(image), media_type] if image else []),
                                     env=env, stdin=selection,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     start_new_session=True)
        with owner.stdout as ready:
            if select.select([ready], [], [], TIMEOUT)[0] and ready.readline() == b"ready\n":
                return
        owner.kill()
        owner.wait()
    except (OSError, subprocess.SubprocessError) as exc:
        raise ClipboardUnavailable from exc
    raise ClipboardUnavailable


def clipboard_state(display, since=""):
    """Wait for a clipboard change after the state named by since."""
    state = json.loads(run_helper(display, ["watch", since], WATCH_SECONDS + 2 * TIMEOUT))
    state["uris"] = base64.b64decode(state["uris"])
    return state


def clipboard_image(display):
    return run_helper(display, ["image"], IMAGE_TIMEOUT)


def run_helper(display, command, timeout):
    env = dict(os.environ, DISPLAY=display, GDK_BACKEND="x11")
    try:
        return subprocess.run([sys.executable, str(Path(__file__).resolve())] + command,
                              env=env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              check=True, timeout=timeout).stdout
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        raise ClipboardUnavailable from exc


class Target(C.Structure):
    _fields_ = [("name", C.c_char_p), ("flags", C.c_uint), ("info", C.c_uint)]


GetSelection = C.CFUNCTYPE(None, C.c_void_p, C.c_void_p, C.c_uint, C.c_void_p)
ClearSelection = C.CFUNCTYPE(None, C.c_void_p, C.c_void_p)
OwnerChange = C.CFUNCTYPE(None, C.c_void_p, C.c_void_p, C.c_void_p)
WatchTimeout = C.CFUNCTYPE(C.c_int, C.c_void_p)


class X11Clipboard:
    def __init__(self):
        gtk = C.CDLL("libgtk-3.so.0")
        gdk = C.CDLL("libgdk-3.so.0")
        glib = C.CDLL("libglib-2.0.so.0")
        gobject = C.CDLL("libgobject-2.0.so.0")
        self.atom = self.bind(gdk.gdk_atom_intern, C.c_void_p, C.c_char_p, C.c_int)
        init = self.bind(gtk.gtk_init_check, C.c_int, C.c_void_p, C.c_void_p)
        if not init(None, None):
            raise ClipboardUnavailable
        get_clipboard = self.bind(gtk.gtk_clipboard_get, C.c_void_p, C.c_void_p)
        self.clipboard = get_clipboard(self.atom(b"CLIPBOARD", 0))
        self.get_contents = self.bind(gtk.gtk_clipboard_wait_for_contents,
                                      C.c_void_p, C.c_void_p, C.c_void_p)
        self.get_length = self.bind(gtk.gtk_selection_data_get_length, C.c_int, C.c_void_p)
        self.get_data = self.bind(gtk.gtk_selection_data_get_data, C.c_void_p, C.c_void_p)
        self.free_data = self.bind(gtk.gtk_selection_data_free, None, C.c_void_p)
        self.set_data = self.bind(gtk.gtk_selection_data_set, None, C.c_void_p,
                                  C.c_void_p, C.c_int, C.c_char_p, C.c_int)
        self.set_owner = self.bind(gtk.gtk_clipboard_set_with_data, C.c_int,
                                   C.c_void_p, C.POINTER(Target), C.c_uint,
                                   GetSelection, ClearSelection, C.c_void_p)
        self.get_targets = self.bind(gtk.gtk_selection_data_get_targets, C.c_int, C.c_void_p,
                                     C.POINTER(C.POINTER(C.c_void_p)), C.POINTER(C.c_int))
        self.atom_name = self.bind(gdk.gdk_atom_name, C.c_void_p, C.c_void_p)
        self.free = self.bind(glib.g_free, None, C.c_void_p)
        self.add_timeout = self.bind(glib.g_timeout_add_seconds, C.c_uint,
                                     C.c_uint, WatchTimeout, C.c_void_p)
        self.connect = self.bind(gobject.g_signal_connect_data, C.c_ulong, C.c_void_p, C.c_char_p,
                                 OwnerChange, C.c_void_p, C.c_void_p, C.c_int)
        self.run = self.bind(gtk.gtk_main, None)
        self.quit = self.bind(gtk.gtk_main_quit, None)

    @staticmethod
    def bind(function, result, *arguments):
        function.restype = result
        function.argtypes = arguments
        return function

    def contents(self, target, limit=MAX_SELECTION_BYTES):
        data = self.get_contents(self.clipboard, self.atom(target, 0))
        if not data:
            return b""
        try:
            length = self.get_length(data)
            if length > limit:
                raise ClipboardUnavailable
            return C.string_at(self.get_data(data), length) if length > 0 else b""
        finally:
            self.free_data(data)

    def read(self):
        action, _, uris = self.contents(GNOME_FILES).partition(b"\n")
        if action.rstrip(b"\r") in (b"copy", b"cut"):
            return uris
        return self.contents(URI_LIST)

    def targets(self):
        data = self.get_contents(self.clipboard, self.atom(b"TARGETS", 0))
        if not data:
            return set()
        atoms = C.POINTER(C.c_void_p)()
        count = C.c_int()
        try:
            if not self.get_targets(data, C.byref(atoms), C.byref(count)):
                return set()
            names = set()
            for index in range(count.value):
                name = self.atom_name(atoms[index])
                names.add(C.string_at(name))
                self.free(name)
            self.free(atoms)
            return names
        finally:
            self.free_data(data)

    def state(self):
        targets = self.targets()
        uris = b""
        kind = "none"
        if ORIGIN not in targets:
            if targets & {GNOME_FILES, URI_LIST}:
                uris = self.read()
            if uris.strip():
                kind = "files"
            elif targets & TEXT_TARGETS:
                kind = "text"  # VNC already carries text to the browser.
            elif IMAGE_PNG in targets:
                kind = "image"
        token = hashlib.sha256(b"\0".join(sorted(targets) + [uris])).hexdigest()[:32]
        return {"token": token, "kind": kind, "uris": uris}

    def watch(self, since):
        fired = []
        waiting = []

        def stop():
            if waiting:
                waiting.clear()
                self.quit()

        @OwnerChange
        def changed(_clipboard, _event, _user_data):
            fired.append(True)
            stop()

        @WatchTimeout
        def expired(_user_data):
            stop()
            return 0

        # Listen before reading, so a copy made in between is not missed.
        self.connect(self.clipboard, b"owner-change", changed, None, None, 0)
        state = self.state()
        if since and state["token"] == since and not fired:
            self.add_timeout(WATCH_SECONDS, expired, None)
            waiting.append(True)
            self.run()
            if fired:
                state = self.state()
        state["changed"] = bool(since) and (bool(fired) or state["token"] != since)
        return state

    def write(self, uris, image=None, media_type=IMAGE_PNG):
        names = (GNOME_FILES, URI_LIST, ORIGIN) + ((media_type,) if image else ())
        targets = (Target * len(names))(*(Target(name, 0, i) for i, name in enumerate(names)))
        atoms = tuple(self.atom(name, 0) for name in names)
        contents = (b"copy\n" + uris, b"\r\n".join(uris.splitlines()) + b"\r\n", b"1", image)

        @GetSelection
        def provide(_clipboard, data, index, _user_data):
            payload = contents[index]
            self.set_data(data, atoms[index], 8, payload, len(payload))

        @ClearSelection
        def clear(_clipboard, _user_data):
            self.quit()

        if not self.set_owner(self.clipboard, targets, len(targets), provide, clear, None):
            raise ClipboardUnavailable
        print("ready", flush=True)
        sys.stdout.close()
        self.run()


if __name__ == "__main__":
    clipboard = X11Clipboard()
    if sys.argv[1] == "read":
        sys.stdout.buffer.write(clipboard.read())
    elif sys.argv[1] == "image":
        sys.stdout.buffer.write(clipboard.contents(IMAGE_PNG, MAX_IMAGE_BYTES))
    elif sys.argv[1] == "watch":
        result = clipboard.watch(sys.argv[2])
        result["uris"] = base64.b64encode(result["uris"]).decode("ascii")
        print(json.dumps(result), flush=True)
    else:
        uris = sys.stdin.buffer.read(MAX_SELECTION_BYTES + 1)
        if not 0 < len(uris) <= MAX_SELECTION_BYTES:
            raise ClipboardUnavailable
        if len(sys.argv) > 2:
            media_type = sys.argv[3].encode("ascii") if len(sys.argv) > 3 else IMAGE_PNG
            clipboard.write(uris, Path(sys.argv[2]).read_bytes(), media_type)
        else:
            clipboard.write(uris)
