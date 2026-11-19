#!/usr/bin/env python3
"""Serve noVNC with remembered browser sessions and chunked file transfers."""

import argparse
import contextlib
import fcntl
import gzip
import hashlib
import hmac
import json
import logging
import os
import re
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import ssl
import stat
import subprocess
import struct
import sys
import threading
import time
import zipfile
from http.cookies import CookieError, SimpleCookie
from http.server import SimpleHTTPRequestHandler
from urllib.parse import parse_qs, quote, unquote, urlsplit

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "websockify"))
sys.path.insert(0, str(REPO / "utils"))
from text_input import TextInputUnavailable, X11TextInput
import window_fit
from file_clipboard import (ClipboardUnavailable, MAX_IMAGE_BYTES, clipboard_image,
                            clipboard_state, desktop_selection)
from websockify.websocket import WebSocketWantReadError
from websockify.websocketproxy import ProxyRequestHandler, WebSocketProxy
from cryptography.hazmat.primitives.ciphers import Cipher, modes
try:
    from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES
except ImportError:
    from cryptography.hazmat.primitives.ciphers.algorithms import TripleDES

API = "/api/files/"
# Scripts are served below /v/<version>/ and cached by browsers forever. The
# version follows the newest script, so an edited file gets a new address.
ASSETS = "/v/"
ASSET_DIRS = ("app", "core", "vendor")
IMPORT_MAP = re.compile(rb'(<script type="importmap"[^>]*>).*?(</script>)', re.S)
# Idle keep-alive connections each hold a process; let them go.
IDLE_SECONDS = 20
# Committed IME text arrives over one standing WebSocket, sparing every
# phrase a new connection. The page pings it well within this limit.
INPUT_SOCKET = API + "input-socket"
INPUT_SOCKET_SECONDS = 90
LINE_ID = re.compile(r"[A-Za-z0-9]{8,32}")
CLIPBOARD_TOKEN = re.compile(r"[0-9a-f]{32}")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
LINE_SECONDS = 2


def line_stats(connection):
    """Round trip time and loss of a TCP connection, as the kernel sees them."""
    try:
        info = connection.getsockopt(socket.IPPROTO_TCP, socket.TCP_INFO, 232)
        rtt, = struct.unpack_from("I", info, 68)
        resent, = struct.unpack_from("I", info, 100)
        sent, = struct.unpack_from("I", info, 136)
        lowest, = struct.unpack_from("I", info, 148)
    except (OSError, struct.error):
        return None
    return {"rtt": round(rtt / 1000), "lowest": round(lowest / 1000),
            "resent": resent, "sent": sent, "micros": rtt}
COOKIE = "novnc_files"
BROWSER_COOKIE = "novnc_browser"
CHUNK_SIZE = 16 * 1024 * 1024
MAX_FILE_SIZE = 10 * 1024 ** 3
CLIPBOARD_FILE_LIMIT = 100
CLIPBOARD_SECONDS = 3600
CLIPBOARD_FOLDER = "folder"
SESSION_SECONDS = 8 * 3600
REMEMBER_SECONDS = 7 * 24 * 3600
UPLOAD_SECONDS = 24 * 3600
# TigerVNC's d3des implementation reverses key bits before standard DES.
PASSWORD_FILE_KEY = bytes([232, 74, 214, 96, 196, 114, 26, 224])


class ChunkedWriter:
    """Write an HTTP response body using chunked transfer encoding."""

    def __init__(self, output):
        self.output = output

    def write(self, data):
        if len(data):
            self.output.write(b"%x\r\n" % len(data) + bytes(data) + b"\r\n")
        return len(data)

    def flush(self):
        pass

    def finish(self):
        self.output.write(b"0\r\n\r\n")


class APIError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code


class FileStore:
    def __init__(self, root, state, password_file):
        self.root = Path(root).expanduser().resolve()
        self.state = Path(state).expanduser().resolve()
        self.password_file = Path(password_file).expanduser()
        # Fail closed when the existing password file cannot be read.
        self.password_bytes()
        self.root.mkdir(parents=True, exist_ok=True)
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.state, 0o700)
        # Staging on the destination filesystem allows atomic publication.
        self.uploads = self.root / ".novnc-uploads"
        self.uploads.mkdir(exist_ok=True, mode=0o700)
        os.chmod(self.uploads, 0o700)
        with self.rate_db() as db:
            db.execute("CREATE TABLE IF NOT EXISTS failures (address TEXT, at REAL)")
            db.execute("CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value BLOB)")
            db.execute("INSERT OR IGNORE INTO settings VALUES ('session_secret', ?)",
                       (secrets.token_bytes(32),))
            self.secret = db.execute("SELECT value FROM settings WHERE name = 'session_secret'").fetchone()[0]
            db.execute("CREATE TABLE IF NOT EXISTS revoked (owner TEXT PRIMARY KEY, expiry INTEGER)")
            db.execute("""CREATE TABLE IF NOT EXISTS clipboard_downloads
                          (token TEXT PRIMARY KEY, owner TEXT, path TEXT, revision TEXT, expiry INTEGER)""")

    @contextlib.contextmanager
    def rate_db(self):
        connection = sqlite3.connect(self.state / "auth.sqlite3", timeout=10)
        try:
            with connection:
                yield connection
        finally:
            # Close before websockify daemonizes and reuses file descriptors.
            connection.close()

    def password_bytes(self):
        data = self.password_file.read_bytes()
        if len(data) < 8:
            raise RuntimeError("A VNC password file is required for file transfers")
        return data[:8]  # The first password is the full-access VNC password.

    def authenticate(self, password, address, browser=False):
        with self.rate_db() as db:
            db.execute("DELETE FROM failures WHERE at < ?", (time.time() - 60,))
            attempts = db.execute("SELECT COUNT(*) FROM failures WHERE address = ?",
                                  (address,)).fetchone()[0]
            if attempts >= 10:
                raise APIError(429, "too_many_attempts")
            decryptor = Cipher(TripleDES(PASSWORD_FILE_KEY), modes.ECB()).decryptor()
            expected = decryptor.update(self.password_bytes()) + decryptor.finalize()
            # Match noVNC's first eight JavaScript UTF-16 code units (low byte).
            candidate = password.encode("utf-16-le", errors="surrogatepass")[::2][:8]
            candidate = candidate.ljust(8, b"\0")
            if not hmac.compare_digest(expected, candidate):
                db.execute("INSERT INTO failures VALUES (?, ?)", (address, time.time()))
                # Commit before raising: the context manager rolls back exceptions.
                db.commit()
                raise APIError(401, "invalid_password")
            db.execute("DELETE FROM failures WHERE address = ?", (address,))
            db.execute("DELETE FROM revoked WHERE expiry <= ?", (time.time(),))
        lifetime = REMEMBER_SECONDS if browser else SESSION_SECONDS
        payload = f"{int(time.time()) + lifetime}.{secrets.token_hex(16)}"
        return payload + "." + self.signature(payload, browser)

    def signature(self, payload, browser=False):
        key = hmac.digest(self.secret, self.password_bytes(), "sha256")
        if browser:
            payload = BROWSER_COOKIE + ":" + payload
        return hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()

    def session(self, cookie_header, browser=False):
        try:
            cookie = SimpleCookie(cookie_header or "")
            token = cookie[BROWSER_COOKIE if browser else COOKIE].value
            expiry, owner, signature = token.split(".")
            if int(expiry) <= time.time() or len(owner) != 32:
                raise ValueError()
            if not hmac.compare_digest(self.signature(expiry + "." + owner, browser), signature):
                raise ValueError()
            if browser:
                with self.rate_db() as db:
                    if db.execute("SELECT 1 FROM revoked WHERE owner = ?", (owner,)).fetchone():
                        raise ValueError()
            return owner
        except (CookieError, KeyError, ValueError):
            raise APIError(401, "authentication_required") from None

    def forget_browser(self, cookie_header):
        try:
            owner = self.session(cookie_header, browser=True)
        except APIError:
            return
        with self.rate_db() as db:
            db.execute("INSERT OR REPLACE INTO revoked VALUES (?, ?)",
                       (owner, int(time.time()) + REMEMBER_SECONDS))

    def vnc_response(self, challenge):
        if (not isinstance(challenge, list) or len(challenge) != 16 or
                any(type(value) is not int or not 0 <= value <= 255 for value in challenge)):
            raise APIError(400, "invalid_request")
        decryptor = Cipher(TripleDES(PASSWORD_FILE_KEY), modes.ECB()).decryptor()
        password = decryptor.update(self.password_bytes()) + decryptor.finalize()
        key = bytes(int(f"{value:08b}"[::-1], 2) for value in password)
        encryptor = Cipher(TripleDES(key), modes.ECB()).encryptor()
        return list(encryptor.update(bytes(challenge)) + encryptor.finalize())

    @staticmethod
    def components(path):
        if not isinstance(path, str) or len(path) > 4096:
            raise APIError(400, "invalid_path")
        if not path:
            return []
        parts = path.split("/")
        for part in parts:
            if (not part or len(part.encode("utf-8")) > 240 or
                    part.startswith(".") or "\\" in part or
                    any(ord(c) < 32 or ord(c) == 127 for c in part)):
                raise APIError(400, "invalid_path")
        return parts

    @contextlib.contextmanager
    def directory(self, path):
        # Walk using directory descriptors: no symlinks or path-swap escapes.
        fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in self.components(path):
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                dir_fd=fd)
                os.close(fd)
                fd = child
            yield fd
        finally:
            os.close(fd)

    def listing(self, path):
        entries = []
        with self.directory(path) as fd:
            with os.scandir(fd) as scan:
                for entry in scan:
                    if entry.name.startswith("."):
                        continue
                    try:
                        self.components(entry.name)
                        info = entry.stat(follow_symlinks=False)
                    except (OSError, APIError):
                        continue
                    if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                        continue
                    directory = stat.S_ISDIR(info.st_mode)
                    item = {"name": entry.name, "directory": directory,
                            "size": info.st_size, "modified": info.st_mtime}
                    if not directory:
                        item["trashId"] = self.file_revision(info)
                    entries.append(item)
        entries.sort(key=lambda e: (not e["directory"], e["name"].casefold()))
        return {"path": path, "entries": entries, "root": str(self.root),
                "chunkSize": CHUNK_SIZE, "maxFileSize": MAX_FILE_SIZE}

    @staticmethod
    def file_revision(info):
        return f"{info.st_dev:x}-{info.st_ino:x}-{info.st_ctime_ns:x}"

    def clipboard_uris(self, paths):
        if not isinstance(paths, list) or not 0 < len(paths) <= CLIPBOARD_FILE_LIMIT:
            raise APIError(400, "invalid_clipboard_selection")
        uris = []
        for path in paths:
            parts = self.components(path)
            if not parts:
                raise APIError(400, "invalid_path")
            with self.directory("/".join(parts[:-1])) as fd:
                info = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
                if not stat.S_ISREG(info.st_mode):
                    raise APIError(403, "invalid_path")
            uris.append(self.root.joinpath(*parts).as_uri().encode("ascii"))
        return uris

    @staticmethod
    def open_copied_file(path):
        parts = Path(path).parts
        if len(parts) < 2 or parts[0] != "/" or ".." in parts or "\0" in path:
            raise APIError(400, "invalid_path")
        # Open the clipboard entry without following symlinks or opening a
        # device. Reopen the verified inode itself for reading.
        flags = os.O_PATH | os.O_NOFOLLOW
        fd = os.open("/", flags | os.O_DIRECTORY)
        try:
            for part in parts[1:-1]:
                child = os.open(part, flags | os.O_DIRECTORY, dir_fd=fd)
                os.close(fd)
                fd = child
            entry = os.open(parts[-1], flags, dir_fd=fd)
            os.close(fd)
            fd = entry
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise APIError(403, "invalid_path")
            return open(f"/proc/self/fd/{fd}", "rb")
        finally:
            os.close(fd)

    def register_clipboard(self, owner, selection):
        rows, files = [], []
        paths = set()
        skipped = 0
        now = int(time.time())
        for line in selection.splitlines():
            if not line or line.startswith(b"#"):
                continue
            try:
                uri = urlsplit(line.rstrip(b"\0").decode("utf-8"))
                if (uri.scheme != "file" or uri.netloc.lower() not in ("", "localhost") or
                        uri.query or uri.fragment):
                    raise ValueError
                # File managers report the path as browsed, which may pass
                # through shortcuts such as the transfer folder on the desktop.
                path = os.path.realpath(unquote(uri.path, errors="strict"))
                if path in paths:
                    continue
                if len(files) >= CLIPBOARD_FILE_LIMIT:
                    skipped += 1
                    continue
                token = secrets.token_hex(16)
                if os.path.isdir(path):
                    if path == "/":
                        raise ValueError
                    revision = CLIPBOARD_FOLDER
                    entry = {"id": token, "name": Path(path).name + ".zip", "size": 0, "folder": True}
                else:
                    with self.open_copied_file(path) as file:
                        info = os.fstat(file.fileno())
                    revision = self.file_revision(info)
                    entry = {"id": token, "name": Path(path).name, "size": info.st_size}
                paths.add(path)
                rows.append((token, owner, path, revision, now + CLIPBOARD_SECONDS))
                files.append(entry)
            except (OSError, ValueError, APIError):
                skipped += 1
        with self.rate_db() as db:
            db.execute("DELETE FROM clipboard_downloads WHERE expiry <= ?", (now,))
            db.executemany("INSERT INTO clipboard_downloads VALUES (?, ?, ?, ?, ?)", rows)
            db.execute("""DELETE FROM clipboard_downloads WHERE owner = ? AND token NOT IN (
                            SELECT token FROM clipboard_downloads WHERE owner = ?
                            ORDER BY rowid DESC LIMIT ?)""",
                       (owner, owner, 4 * CLIPBOARD_FILE_LIMIT))
        return {"files": files, "skipped": skipped}

    def clipboard_folder(self, token, owner):
        with self.rate_db() as db:
            entry = db.execute("""SELECT path FROM clipboard_downloads
                                  WHERE token = ? AND owner = ? AND revision = ? AND expiry > ?""",
                               (token, owner, CLIPBOARD_FOLDER, int(time.time()))).fetchone()
        return entry and entry[0]

    @contextlib.contextmanager
    def clipboard_download(self, token, owner):
        with self.rate_db() as db:
            entry = db.execute("""SELECT path, revision FROM clipboard_downloads
                                  WHERE token = ? AND owner = ? AND expiry > ?""",
                               (token, owner, int(time.time()))).fetchone()
        if entry is None:
            raise APIError(404, "not_found")
        path, revision = entry
        with self.open_copied_file(path) as file:
            if self.file_revision(os.fstat(file.fileno())) != revision:
                raise APIError(409, "file_changed")
            yield file, Path(path).name

    def save_clipboard_image(self, image):
        """Keep the latest pasted image where file managers can copy it from."""
        folder = self.state / "clipboard"
        folder.mkdir(mode=0o700, exist_ok=True)
        target = folder / "clipboard-image.png"
        partial = folder / f".{secrets.token_hex(8)}.part"
        try:
            with open(os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as file:
                file.write(image)
            os.replace(partial, target)
        finally:
            partial.unlink(missing_ok=True)
        return target

    def trash(self, path, revision):
        parts = self.components(path)
        if not parts or not isinstance(revision, str):
            raise APIError(400, "invalid_path")
        name = parts[-1]
        with self.directory("/".join(parts[:-1])) as fd:
            fcntl.flock(fd, fcntl.LOCK_EX)
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):
                raise APIError(403, "invalid_path")
            if revision != self.file_revision(info):
                raise APIError(409, "file_changed")
            # Run from the verified parent directory. GIO handles the desktop
            # Trash metadata, duplicate names and separate volumes.
            try:
                subprocess.run(["gio", "trash", "./" + name], cwd=f"/proc/self/fd/{fd}",
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                               check=True, timeout=15)
            except (OSError, subprocess.SubprocessError) as exc:
                raise APIError(409, "trash_unavailable") from exc

    def create_upload(self, owner, data):
        name, path, size = data.get("name"), data.get("path", ""), data.get("size")
        if len(self.components(name)) != 1:
            raise APIError(400, "invalid_path")
        if type(size) is not int or size < 0 or size > MAX_FILE_SIZE:
            raise APIError(413, "file_too_large")
        with self.directory(path):
            pass
        if shutil.disk_usage(self.root).free < size + CHUNK_SIZE:
            raise APIError(507, "not_enough_space")
        for manifest in self.uploads.glob("*.json"):
            if manifest.stat().st_mtime < time.time() - UPLOAD_SECONDS:
                manifest.with_suffix(".part").unlink(missing_ok=True)
                manifest.unlink(missing_ok=True)
        if len(list(self.uploads.glob("*.json"))) >= 32:
            raise APIError(429, "too_many_uploads")
        upload_id = secrets.token_hex(24)
        metadata = {"owner": owner, "name": name, "path": path, "size": size}
        (self.uploads / (upload_id + ".part")).touch(mode=0o600, exist_ok=False)
        (self.uploads / (upload_id + ".json")).write_text(json.dumps(metadata))
        return {"id": upload_id, "chunkSize": CHUNK_SIZE}

    @contextlib.contextmanager
    def upload(self, upload_id, owner):
        if len(upload_id) != 48 or any(c not in "0123456789abcdef" for c in upload_id):
            raise APIError(400, "invalid_upload")
        part = self.uploads / (upload_id + ".part")
        manifest = part.with_suffix(".json")
        with part.open("r+b") as file:
            fcntl.flock(file, fcntl.LOCK_EX)
            metadata = json.loads(manifest.read_text())
            if not hmac.compare_digest(metadata["owner"], owner):
                raise APIError(403, "invalid_upload")
            if manifest.stat().st_mtime < time.time() - UPLOAD_SECONDS:
                raise APIError(410, "upload_expired")
            yield file, metadata, part, manifest

    def complete(self, upload_id, owner):
        with self.upload(upload_id, owner) as (file, meta, part, manifest):
            if os.fstat(file.fileno()).st_size != meta["size"]:
                raise APIError(409, "incomplete_upload")
            file.flush()
            os.fsync(file.fileno())
            with self.directory(meta["path"]) as fd:
                stem, ext = os.path.splitext(meta["name"])
                for counter in range(10000):
                    name = meta["name"] if counter == 0 else f"{stem} ({counter}){ext}"
                    try:
                        # A hard link publishes the completed file atomically without overwrite.
                        os.link(part, name, dst_dir_fd=fd, follow_symlinks=False)
                        os.fsync(fd)
                        break
                    except FileExistsError:
                        continue
                else:
                    raise APIError(409, "name_conflict")
            part.unlink()
            manifest.unlink()
            return {"name": name, "size": meta["size"]}


class FileRequestHandler(ProxyRequestHandler):
    timeout = IDLE_SECONDS
    own_cache_control = False

    def handle_upgrade(self):
        if urlsplit(self.path).path == INPUT_SOCKET:
            # Browsers send cookies with cross-site WebSockets, so the
            # page's origin is checked before the session is trusted.
            store = self.server.file_store
            try:
                if not self.headers.get("Origin"):
                    raise APIError(403, "invalid_origin")
                self.check_origin()
                try:
                    store.session(self.headers.get("Cookie"))
                except APIError:
                    store.session(self.headers.get("Cookie"), browser=True)
            except APIError as exc:
                self.own_cache_control = False
                self.close_connection = True
                self.send_error(exc.status)
                return
        super().handle_upgrade()

    def new_websocket_client(self):
        if urlsplit(self.path).path == INPUT_SOCKET:
            self.serve_input_socket()
            return
        query = parse_qs(urlsplit(self.path).query)
        # The VNC stream has no idle limit and must never time out on a
        # slow send.
        self.connection.settimeout(None)
        stats = line_stats(self.connection)
        if stats and stats["rtt"] > 0:
            self.log_message("line: %d ms round trip", stats["rtt"])
        line = query.get("line", [""])[0]
        report = None
        if LINE_ID.fullmatch(line):
            report = self.server.file_store.state / "lines" / (line + ".json")
            stop = threading.Event()
            reporter = threading.Thread(target=self.report_line, args=(report, stop), daemon=True)
            reporter.start()
        try:
            super().new_websocket_client()
        finally:
            if report:
                stop.set()
                reporter.join()
                with contextlib.suppress(OSError):
                    report.unlink()

    def report_line(self, report, stop):
        """Keep a note of how this connection is doing, for the page to show."""
        report.parent.mkdir(mode=0o700, exist_ok=True)
        while not stop.is_set():
            stats = line_stats(self.connection)
            if stats is None:
                return
            stats.update(node=self.client_address[0])
            if self.client_address[0] in ("127.0.0.1", "::1"):
                # A tunnel on this machine: its line is not ours to measure.
                # Cloudflare names the data center the browser reached.
                stats = {"node": "127.0.0.1"}
                place = self.headers.get("CF-Ray", "").rpartition("-")[2]
                if re.fullmatch(r"[A-Za-z]{3}", place):
                    stats["node"] = "Cloudflare " + place.upper()
            scratch = report.with_suffix(".tmp")
            try:
                scratch.write_text(json.dumps(stats))
                os.replace(scratch, report)
            except OSError:
                return
            stop.wait(LINE_SECONDS)

    def type_text(self, text):
        display = getattr(self.server, "text_input_display", None)
        if not display:
            raise APIError(501, "text_input_unavailable")
        if (not isinstance(text, str) or not 0 < len(text) <= 128 or
                any(0xd800 <= ord(char) <= 0xdfff or
                    ord(char) < 32 and char not in "\r\n\t" for char in text)):
            raise APIError(400, "invalid_request")
        with open(self.server.file_store.state / "text-input.lock", "a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise APIError(409, "text_input_busy") from None
            try:
                with X11TextInput(display) as input_handler:
                    input_handler.send(text)
            except TextInputUnavailable:
                raise APIError(501, "text_input_unavailable") from None
            except Exception:
                # Delivery might be partial. Never tell the client to retry
                # with another transport and duplicate an entered prefix.
                raise APIError(500, "text_input_failed") from None

    def fit_windows(self, mode):
        display = getattr(self.server, "text_input_display", None)
        if not display:
            raise APIError(501, "window_fit_unavailable")
        if mode not in ("fit", "restore"):
            raise APIError(400, "invalid_request")
        record = self.server.file_store.state / "fitted-windows.json"
        try:
            count = window_fit.apply(display, record, mode)
        except OSError:
            raise APIError(501, "window_fit_unavailable") from None
        if mode == "fit":
            # Follows later size changes by itself; exits at once when
            # one is already running, and for good after a restore
            subprocess.Popen(
                [sys.executable, window_fit.__file__, "watch", display, str(record)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True, close_fds=True)
        return count

    def serve_input_socket(self):
        socket = self.request
        self.connection.settimeout(INPUT_SOCKET_SECONDS)
        while True:
            try:
                message = socket.recvmsg()
            except WebSocketWantReadError:
                continue
            except OSError:
                return
            if message is None:
                return
            try:
                data = json.loads(message)
                if not isinstance(data, dict):
                    raise ValueError()
            except (ValueError, UnicodeError):
                return
            if data.get("ping"):
                reply = {"pong": True}
            else:
                reply = {"id": data.get("id")}
                try:
                    self.type_text(data.get("text"))
                    reply["typed"] = True
                except APIError as exc:
                    reply["error"] = exc.code
            try:
                socket.sendmsg(json.dumps(reply).encode())
            except OSError:
                return

    def log_error(self, format, *args):
        if format.startswith("Request timed out"):
            return
        super().log_error(format, *args)

    def asset_version(self):
        newest = 0
        for name in ASSET_DIRS:
            for folder, _, files in os.walk(os.path.join(self.server.web, name)):
                for file in files:
                    if file.endswith(".js"):
                        newest = max(newest, os.stat(os.path.join(folder, file)).st_mtime_ns)
        return "%x" % newest

    def send_static(self, content, content_type, cache_control):
        if "gzip" in self.headers.get("Accept-Encoding", ""):
            content = gzip.compress(content, 6)
            encoding = "gzip"
        else:
            encoding = None
        self.own_cache_control = True
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", cache_control)
        self.send_header("Vary", "Accept-Encoding")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def serve_static(self):
        """Serve the page and its versioned scripts; False for anything else."""
        self.own_cache_control = False
        path = urlsplit(self.path).path
        web = self.server.web
        if path == "/vnc.html":
            try:
                page = Path(web, "vnc.html").read_bytes()
            except OSError:
                return False
            prefix = "." + ASSETS + self.asset_version() + "/"
            imports = {"./%s/" % name: prefix + name + "/" for name in ASSET_DIRS}
            page = IMPORT_MAP.sub(
                lambda match: match.group(1) + json.dumps({"imports": imports}).encode() +
                match.group(2), page, count=1)
            self.send_static(page, "text/html; charset=utf-8", "no-cache")
            return True
        if path.startswith(ASSETS):
            parts = path[len(ASSETS):].split("/")[1:]
            if (len(parts) < 2 or parts[0] not in ASSET_DIRS or not parts[-1].endswith(".js") or
                    any(not part or part.startswith(".") or "\\" in part for part in parts)):
                self.send_error(404)
                return True
            try:
                content = Path(web, *parts).read_bytes()
            except OSError:
                self.send_error(404)
                return True
            self.send_static(content, "text/javascript; charset=utf-8",
                             "public, max-age=31536000, immutable")
            return True
        return False

    def end_headers(self):
        if self.own_cache_control:
            SimpleHTTPRequestHandler.end_headers(self)
        elif urlsplit(self.path).path.startswith(API):
            self.send_header("Cache-Control", "no-store, private")
            self.send_header("X-Content-Type-Options", "nosniff")
            # Skip websockify's additional Cache-Control header for API replies.
            SimpleHTTPRequestHandler.end_headers(self)
        else:
            super().end_headers()

    def reply(self, status, data, cookie=None):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def cookie(self, value, lifetime=SESSION_SECONDS, browser=False):
        secure = isinstance(self.connection, ssl.SSLSocket)
        secure = secure or self.headers.get("X-Forwarded-Proto") == "https"
        name, path = (BROWSER_COOKIE, "/") if browser else (COOKIE, API)
        return (f"{name}={value}; Path={path}; HttpOnly; SameSite=Strict; "
                f"Max-Age={lifetime}" + ("; Secure" if secure else ""))

    def check_origin(self):
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise APIError(403, "invalid_origin")
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host"):
            raise APIError(403, "invalid_origin")
        if self.command in ("POST", "PUT"):
            if self.headers.get("X-NoVNC-Transfer") != "1":
                raise APIError(403, "invalid_origin")

    def byte_range(self, size, etag):
        """Return the inclusive (start, end) of a single-range request."""
        full = (0, size - 1)
        header = self.headers.get("Range")
        if not header or size == 0:
            return full
        # The file changed since the first part was fetched: send all of it.
        if self.headers.get("If-Range") not in (None, etag):
            return full
        unit, _, spec = header.partition("=")
        first, dash, last = spec.strip().partition("-")
        if unit.strip() != "bytes" or not dash or "," in spec:
            return full
        try:
            if first == "":
                start, end = max(0, size - int(last)), size - 1
                if int(last) <= 0:
                    raise ValueError()
            else:
                start = int(first)
                end = min(int(last), size - 1) if last else size - 1
            if not 0 <= start <= end:
                raise ValueError()
        except ValueError:
            raise APIError(416, "invalid_range") from None
        if start >= size:
            raise APIError(416, "invalid_range")
        return start, end

    def body_length(self, maximum):
        try:
            length = int(self.headers["Content-Length"])
        except (TypeError, ValueError):
            raise APIError(411, "length_required") from None
        if self.headers.get("Transfer-Encoding") or not 0 <= length <= maximum:
            raise APIError(413, "file_too_large")
        return length

    def read_json(self, maximum=16384):
        if self.headers.get_content_type() != "application/json":
            raise APIError(415, "invalid_request")
        length = self.body_length(maximum)
        body = self.rfile.read(length)
        if len(body) != length:
            raise APIError(400, "incomplete_upload")
        try:
            result = json.loads(body)
            if not isinstance(result, dict):
                raise ValueError()
            return result
        except (ValueError, UnicodeError):
            raise APIError(400, "invalid_request") from None

    def desktop_clipboard(self, function, *args):
        display = getattr(self.server, "text_input_display", None)
        if not display:
            raise APIError(501, "clipboard_unavailable")
        try:
            return function(display, *args)
        except ClipboardUnavailable:
            raise APIError(501, "clipboard_unavailable") from None

    def file_clipboard(self, paths=None):
        return self.desktop_clipboard(desktop_selection, paths)

    def watch_clipboard(self, owner, since):
        if since and not CLIPBOARD_TOKEN.fullmatch(since):
            raise APIError(400, "invalid_request")
        state = self.desktop_clipboard(clipboard_state, since)
        uris = state.pop("uris")
        if state["changed"] and state["kind"] == "files":
            state.update(self.server.file_store.register_clipboard(owner, uris))
        return state

    def receive_clipboard_image(self):
        length = self.body_length(MAX_IMAGE_BYTES)
        image = self.rfile.read(length)
        if len(image) != length:
            raise APIError(400, "incomplete_upload")
        if not image.startswith(PNG_SIGNATURE):
            raise APIError(415, "invalid_request")
        path = self.server.file_store.save_clipboard_image(image)
        self.desktop_clipboard(desktop_selection, [path.as_uri().encode("ascii")], path)

    def send_clipboard_image(self):
        image = self.desktop_clipboard(clipboard_image)
        if not image:
            raise APIError(404, "not_found")
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Length", str(len(image)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(image)

    def send_download(self, file, name):
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise APIError(403, "invalid_path")
        # A validator lets browsers resume an interrupted download.
        etag = '"%x-%x"' % (info.st_mtime_ns, info.st_size)
        start, end = self.byte_range(info.st_size, etag)
        partial = (start, end) != (0, info.st_size - 1) and info.st_size > 0
        self.send_response(206 if partial else 200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", etag)
        if partial:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, info.st_size))
        self.send_header("Content-Disposition",
                         "attachment; filename=\"download\"; filename*=UTF-8''" + quote(name, safe=""))
        remaining = end - start + 1 if info.st_size else 0
        self.send_header("Content-Length", str(remaining))
        self.send_header("Connection", "close")
        self.end_headers()
        file.seek(start)
        while remaining:
            chunk = file.read(min(remaining, 256 * 1024))
            if not chunk:
                break
            self.wfile.write(chunk)
            remaining -= len(chunk)

    def send_folder(self, path):
        """Stream a folder as a zip archive, which needs no temporary copy."""
        root = Path(path)
        if not root.is_dir():
            raise APIError(404, "not_found")
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", "attachment; filename=\"download.zip\"; filename*=UTF-8''" +
                         quote(root.name + ".zip", safe=""))
        # The size is unknown in advance. Chunks mark the end explicitly,
        # so an interrupted download cannot look like a finished one.
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Connection", "close")
        self.end_headers()
        output = ChunkedWriter(self.wfile)
        with zipfile.ZipFile(output, "w", zipfile.ZIP_STORED) as archive:
            for folder, folders, names in os.walk(root):
                folders.sort()
                relative = Path(root.name, Path(folder).relative_to(root))
                if not folders and not names:
                    archive.writestr(relative.as_posix() + "/", b"")
                for name in sorted(names):
                    source = Path(folder, name)
                    try:
                        if not stat.S_ISREG(source.lstat().st_mode):
                            continue
                        file = open(source, "rb")
                    except (PermissionError, FileNotFoundError):
                        continue  # Unreadable, or removed during the download
                    with file:
                        info = zipfile.ZipInfo.from_file(source, (relative / name).as_posix(),
                                                         strict_timestamps=False)
                        with archive.open(info, "w", force_zip64=True) as target:
                            shutil.copyfileobj(file, target, 256 * 1024)
        output.finish()

    def dispatch(self):
        self.own_cache_control = False
        self.close_connection = True
        self.connection.settimeout(120)
        try:
            self.check_origin()
            self.route()
        except APIError as exc:
            self.reply(exc.status, {"error": exc.code})
        except FileNotFoundError:
            self.reply(404, {"error": "not_found"})
        except (NotADirectoryError, IsADirectoryError, PermissionError):
            self.reply(403, {"error": "invalid_path"})
        except UnicodeError:
            self.reply(400, {"error": "invalid_path"})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except OSError as exc:
            # ELOOP is an explicitly rejected symlink, ENOSPC is a full disk.
            code = "not_enough_space" if exc.errno == 28 else "invalid_path"
            self.reply(507 if exc.errno == 28 else 403, {"error": code})

    def route(self):
        store = self.server.file_store
        url = urlsplit(self.path)
        endpoint = url.path[len(API):]
        query = parse_qs(url.query, keep_blank_values=True)
        param = lambda name, default="": query.get(name, [default])[0]
        if endpoint in ("session", "browser-session") and self.command == "POST":
            data = self.read_json()
            password = data.get("password")
            if not isinstance(password, str) or len(password) > 1024:
                raise APIError(400, "invalid_request")
            address = self.client_address[0]
            if address in ("127.0.0.1", "::1"):
                address = self.headers.get("CF-Connecting-IP", address)
            browser = endpoint == "browser-session"
            token = store.authenticate(password, address, browser)
            lifetime = REMEMBER_SECONDS if browser else SESSION_SECONDS
            self.reply(200, {"authenticated": True}, self.cookie(token, lifetime, browser))
            return
        if endpoint == "forget-browser" and self.command == "POST":
            store.forget_browser(self.headers.get("Cookie"))
            self.reply(200, {}, self.cookie("", 0, browser=True))
            return
        if endpoint == "vnc-response" and self.command == "POST":
            store.session(self.headers.get("Cookie"), browser=True)
            self.reply(200, {"response": store.vnc_response(self.read_json().get("challenge"))})
            return
        if endpoint == "logout" and self.command == "POST":
            self.reply(200, {}, self.cookie("", 0))
            return
        if endpoint == "line" and self.command == "GET":
            # Known only to the page that made the connection
            if not LINE_ID.fullmatch(param("id")):
                raise APIError(400, "invalid_request")
            report = store.state / "lines" / (param("id") + ".json")
            if time.time() - report.stat().st_mtime > 5 * LINE_SECONDS:
                raise FileNotFoundError()
            self.reply(200, json.loads(report.read_text()))
            return
        try:
            owner = store.session(self.headers.get("Cookie"))
        except APIError:
            owner = store.session(self.headers.get("Cookie"), browser=True)
        if endpoint == "fit-windows" and self.command == "POST":
            self.reply(200, {"windows": self.fit_windows(self.read_json().get("mode"))})
        elif endpoint == "input-text" and self.command == "POST":
            self.type_text(self.read_json().get("text"))
            self.reply(200, {"typed": True})
        elif endpoint == "list" and self.command == "GET":
            self.reply(200, store.listing(param("path")))
        elif endpoint == "trash" and self.command == "POST":
            data = self.read_json()
            store.trash(data.get("path"), data.get("revision"))
            self.reply(200, {})
        elif endpoint == "clipboard-watch" and self.command == "GET":
            self.reply(200, self.watch_clipboard(owner, param("since")))
        elif endpoint == "clipboard-image" and self.command == "GET":
            self.send_clipboard_image()
        elif endpoint == "clipboard-image" and self.command == "POST":
            self.receive_clipboard_image()
            self.reply(200, {})
        elif endpoint == "clipboard-list" and self.command == "POST":
            self.reply(200, store.register_clipboard(owner, self.file_clipboard()))
        elif endpoint == "clipboard" and self.command == "POST":
            paths = self.read_json(512 * 1024).get("paths")
            self.file_clipboard(store.clipboard_uris(paths))
            self.reply(200, {})
        elif endpoint == "clipboard-download" and self.command == "GET":
            folder = store.clipboard_folder(param("id"), owner)
            if folder:
                self.send_folder(folder)
                return
            with store.clipboard_download(param("id"), owner) as (file, name):
                self.send_download(file, name)
        elif endpoint == "download" and self.command == "GET":
            parts = store.components(param("path"))
            if not parts:
                raise APIError(400, "invalid_path")
            with store.directory("/".join(parts[:-1])) as fd:
                file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                  dir_fd=fd)
            with os.fdopen(file_fd, "rb") as file:
                self.send_download(file, parts[-1])
        elif endpoint == "upload" and self.command == "GET":
            with store.upload(param("id"), owner) as (file, meta, part, manifest):
                self.reply(200, {"offset": os.fstat(file.fileno()).st_size})
        elif endpoint == "upload" and self.command == "POST":
            self.reply(201, store.create_upload(owner, self.read_json()))
        elif endpoint == "upload" and self.command == "PUT":
            length = self.body_length(CHUNK_SIZE)
            try:
                offset = int(param("offset"))
            except ValueError:
                raise APIError(400, "invalid_request") from None
            with store.upload(param("id"), owner) as (file, meta, part, manifest):
                current = os.fstat(file.fileno()).st_size
                if current != offset or current + length > meta["size"]:
                    raise APIError(409, "invalid_offset")
                file.seek(current)
                remaining = length
                try:
                    while remaining:
                        chunk = self.rfile.read(min(remaining, 256 * 1024))
                        if not chunk:
                            raise APIError(400, "incomplete_upload")
                        file.write(chunk)
                        remaining -= len(chunk)
                    file.flush()
                    os.utime(manifest)
                except BaseException:
                    file.truncate(current)
                    raise
            self.reply(200, {"offset": current + length})
        elif endpoint == "complete" and self.command == "POST":
            self.reply(200, store.complete(param("id"), owner))
        elif endpoint == "cancel" and self.command == "POST":
            with store.upload(param("id"), owner) as (file, meta, part, manifest):
                part.unlink()
                manifest.unlink()
            self.reply(200, {})
        else:
            raise APIError(404, "not_found")

    def do_GET(self):
        if urlsplit(self.path).path.startswith(API):
            self.own_cache_control = False
            self.dispatch()
        elif self.headers.get("Upgrade") or not self.serve_static():
            super().do_GET()

    def do_HEAD(self):
        if urlsplit(self.path).path.startswith(API):
            self.own_cache_control = False
            self.send_error(405)
        elif not self.serve_static():
            super().do_HEAD()

    def do_POST(self):
        if urlsplit(self.path).path.startswith(API):
            self.dispatch()
        else:
            super().do_POST()

    def do_PUT(self):
        if urlsplit(self.path).path.startswith(API):
            self.dispatch()
        else:
            super().do_PUT()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=6990)
    parser.add_argument("--target-host", default="127.0.0.1")
    parser.add_argument("--target-port", type=int, default=5901)
    parser.add_argument("--input-display", help="Local X11 display for clipboard-free text input")
    parser.add_argument("--web", default=str(REPO))
    parser.add_argument("--files", default=str(Path.home() / "Downloads/noVNC"))
    parser.add_argument("--state", default=str(Path.home() / ".local/state/novnc-files"))
    parser.add_argument("--password-file", default=str(Path.home() / ".vnc/passwd"))
    parser.add_argument("--daemon", action="store_true")
    parser.add_argument("--log-file")
    parser.add_argument("--cert", default=str(REPO / "self.pem"))
    parser.add_argument("--key")
    parser.add_argument("--ssl-only", action="store_true")
    # Accept the old flag so existing launchers still start.
    parser.add_argument("--slow-route-ms", type=float, help=argparse.SUPPRESS)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, filename=args.log_file,
                        format="%(asctime)s %(message)s")
    store = FileStore(args.files, args.state, args.password_file)
    server = WebSocketProxy(RequestHandlerClass=FileRequestHandler,
                            listen_host=args.listen, listen_port=args.port,
                            target_host=args.target_host, target_port=args.target_port,
                            web=args.web, file_only=True, daemon=args.daemon,
                            cert=args.cert, key=args.key, ssl_only=args.ssl_only)
    server.file_store = store
    server.text_input_display = args.input_display
    if (server.text_input_display is None and
            args.target_host in ("127.0.0.1", "localhost", "::1") and
            5900 <= args.target_port <= 5999):
        server.text_input_display = f":{args.target_port - 5900}"
    server.start_server()


if __name__ == "__main__":
    main()
