#!/usr/bin/env python3
"""Serve noVNC with remembered browser sessions and chunked file transfers."""

import argparse
import contextlib
import fcntl
import hashlib
import hmac
import json
import logging
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import ssl
import stat
import sys
import time
from http.cookies import CookieError, SimpleCookie
from http.server import SimpleHTTPRequestHandler
from urllib.parse import parse_qs, quote, urlsplit

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "websockify"))
from websockify.websocketproxy import ProxyRequestHandler, WebSocketProxy
from cryptography.hazmat.primitives.ciphers import Cipher, modes
try:
    from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES
except ImportError:
    from cryptography.hazmat.primitives.ciphers.algorithms import TripleDES

API = "/api/files/"
COOKIE = "novnc_files"
BROWSER_COOKIE = "novnc_browser"
CHUNK_SIZE = 4 * 1024 * 1024
MAX_FILE_SIZE = 10 * 1024 ** 3
SESSION_SECONDS = 8 * 3600
REMEMBER_SECONDS = 7 * 24 * 3600
UPLOAD_SECONDS = 24 * 3600
# TigerVNC's d3des implementation reverses key bits before standard DES.
PASSWORD_FILE_KEY = bytes([232, 74, 214, 96, 196, 114, 26, 224])


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
                    entries.append({"name": entry.name,
                                    "directory": stat.S_ISDIR(info.st_mode),
                                    "size": info.st_size, "modified": info.st_mtime})
        entries.sort(key=lambda e: (not e["directory"], e["name"].casefold()))
        return {"path": path, "entries": entries, "root": str(self.root),
                "chunkSize": CHUNK_SIZE, "maxFileSize": MAX_FILE_SIZE}

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
    def end_headers(self):
        if urlsplit(self.path).path.startswith(API):
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

    def body_length(self, maximum):
        try:
            length = int(self.headers["Content-Length"])
        except (TypeError, ValueError):
            raise APIError(411, "length_required") from None
        if self.headers.get("Transfer-Encoding") or not 0 <= length <= maximum:
            raise APIError(413, "file_too_large")
        return length

    def read_json(self):
        if self.headers.get_content_type() != "application/json":
            raise APIError(415, "invalid_request")
        length = self.body_length(16384)
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

    def dispatch(self):
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
        try:
            owner = store.session(self.headers.get("Cookie"))
        except APIError:
            owner = store.session(self.headers.get("Cookie"), browser=True)
        if endpoint == "list" and self.command == "GET":
            self.reply(200, store.listing(param("path")))
        elif endpoint == "download" and self.command == "GET":
            parts = store.components(param("path"))
            if not parts:
                raise APIError(400, "invalid_path")
            with store.directory("/".join(parts[:-1])) as fd:
                file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                                  dir_fd=fd)
            with os.fdopen(file_fd, "rb") as file:
                info = os.fstat(file.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise APIError(403, "invalid_path")
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Disposition",
                                 "attachment; filename=\"download\"; filename*=UTF-8''" +
                                 quote(parts[-1], safe=""))
                self.send_header("Content-Length", str(info.st_size))
                self.send_header("Connection", "close")
                self.end_headers()
                shutil.copyfileobj(file, self.wfile, 256 * 1024)
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
            self.dispatch()
        else:
            super().do_GET()

    def do_HEAD(self):
        if urlsplit(self.path).path.startswith(API):
            self.send_error(405)
        else:
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
    parser.add_argument("--web", default=str(REPO))
    parser.add_argument("--files", default=str(Path.home() / "Downloads/noVNC"))
    parser.add_argument("--state", default=str(Path.home() / ".local/state/novnc-files"))
    parser.add_argument("--password-file", default=str(Path.home() / ".vnc/passwd"))
    parser.add_argument("--daemon", action="store_true")
    parser.add_argument("--log-file")
    parser.add_argument("--cert", default=str(REPO / "self.pem"))
    parser.add_argument("--key")
    parser.add_argument("--ssl-only", action="store_true")
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
    server.start_server()


if __name__ == "__main__":
    main()
