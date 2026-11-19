"""Test persistent browser sessions and API routes without starting a server."""
from email.message import Message
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile
from urllib.parse import quote

REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("gateway", REPO / "utils/novnc_gateway.py")
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class BrowserSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="novnc-browser-test-")
        self.work = Path(self.temp.name)
        self.password_file = self.work / "passwd"
        self.set_password("filetest")
        self.store = self.new_store()
        self.token = self.store.authenticate("filetest", "test", browser=True)
        self.cookie = gateway.BROWSER_COOKIE + "=" + self.token

    def tearDown(self):
        self.temp.cleanup()

    def set_password(self, password):
        fixture = subprocess.run(["tigervncpasswd", "-f"], input=(password + "\n").encode(),
                                 capture_output=True, check=True).stdout
        self.password_file.write_bytes(fixture)

    def new_store(self):
        return gateway.FileStore(self.work / "files", self.work / "state", self.password_file)

    def request(self, endpoint, data=None, cookie=None, headers=None, method="POST", raw=None):
        handler = object.__new__(gateway.FileRequestHandler)
        handler.server = SimpleNamespace(file_store=self.store, text_input_display=":98")
        handler.path = gateway.API + endpoint
        handler.command = method
        handler.client_address = ("127.0.0.1", 12345)
        handler.connection = SimpleNamespace(settimeout=lambda value: None)
        body = json.dumps(data or {}).encode() if raw is None else raw
        handler.rfile = io.BytesIO(body)
        handler.headers = Message()
        values = {"Host": "localhost", "Origin": "http://localhost",
                  "X-NoVNC-Transfer": "1", "Content-Type": "application/json",
                  "Content-Length": str(len(body))}
        if cookie is not None:
            values["Cookie"] = cookie
        values.update(headers or {})
        for name, value in values.items():
            handler.headers[name] = value
        replies = []
        handler.reply = lambda status, result, cookie=None: replies.append((status, result, cookie))
        handler.dispatch()
        self.assertEqual(len(replies), 1)
        return replies[0]

    def test_session_survives_gateway_restart_and_has_fixed_expiry(self):
        expiry = int(self.token.split(".")[0])
        with patch.object(gateway.time, "time", return_value=expiry - 1):
            self.assertEqual(self.new_store().session(self.cookie, browser=True),
                             self.token.split(".")[1])
        with patch.object(gateway.time, "time", return_value=expiry):
            with self.assertRaises(gateway.APIError):
                self.store.session(self.cookie, browser=True)

    def test_text_input_requires_authentication_and_valid_unicode(self):
        with patch.object(gateway, "X11TextInput") as native:
            self.assertEqual(self.request("input-text", {"text": "中文😀"})[0], 401)
            for text in [None, "", 42, "a" * 129, "bad\x00", "\ud800"]:
                self.assertEqual(self.request("input-text", {"text": text}, self.cookie)[0], 400)
            native.assert_not_called()
            status, data, _ = self.request("input-text", {"text": "中文😀"}, self.cookie)
            self.assertEqual((status, data), (200, {"typed": True}))
            native.assert_called_once_with(":98")
            native.return_value.__enter__.return_value.send.assert_called_once_with("中文😀")

    def test_text_input_distinguishes_unsupported_and_uncertain_delivery(self):
        with patch.object(gateway, "X11TextInput", side_effect=gateway.TextInputUnavailable()):
            self.assertEqual(self.request("input-text", {"text": "中文"}, self.cookie)[0], 501)
        with patch.object(gateway, "X11TextInput") as native:
            native.return_value.__enter__.return_value.send.side_effect = RuntimeError("Partial delivery")
            self.assertEqual(self.request("input-text", {"text": "中文"}, self.cookie)[0], 500)

    def test_changing_password_invalidates_session(self):
        self.set_password("newpass")
        with self.assertRaises(gateway.APIError):
            self.store.session(self.cookie, browser=True)

    def test_forged_or_file_session_cannot_answer_vnc_challenge(self):
        for cookie in [None, self.cookie + "x",
                       gateway.BROWSER_COOKIE + "=" + self.store.authenticate("filetest", "test")]:
            self.assertEqual(self.request("vnc-response", {"challenge": list(range(16))}, cookie)[0], 401)

    def test_challenge_validation_and_response(self):
        status, data, _ = self.request("vnc-response", {"challenge": list(range(16))}, self.cookie)
        self.assertEqual(status, 200)
        # Independent fixture from noVNC's JavaScript DES implementation.
        self.assertEqual(data["response"], EXPECTED_RESPONSE)
        self.assertNotIn("password", data)
        for challenge in [None, "0" * 16, [0] * 15, [0] * 17, [True] * 16, [-1] * 16,
                          [256] * 16, [1.5] * 16]:
            self.assertEqual(self.request("vnc-response", {"challenge": challenge}, self.cookie)[0], 400)

    def test_login_cookie_and_wrong_password(self):
        status, data, cookie = self.request("browser-session", {"password": "filetest"},
                                          headers={"X-Forwarded-Proto": "https"})
        self.assertEqual(status, 200)
        self.assertEqual(data, {"authenticated": True})
        for part in ["Path=/;", "HttpOnly;", "SameSite=Strict;", "Secure",
                     f"Max-Age={gateway.REMEMBER_SECONDS}"]:
            self.assertIn(part, cookie)
        self.assertEqual(self.request("browser-session", {"password": "wrong"})[0], 401)

    def test_forget_revokes_cookie_after_restart(self):
        status, _, cookie = self.request("forget-browser", cookie=self.cookie)
        self.assertEqual(status, 200)
        self.assertIn("Max-Age=0", cookie)
        self.store = self.new_store()
        self.assertEqual(self.request("vnc-response", {"challenge": list(range(16))}, self.cookie)[0], 401)
        self.assertEqual(self.request("forget-browser", cookie=self.cookie)[0], 200)

    def test_cross_origin_requests_are_rejected(self):
        for endpoint, data in [("browser-session", {"password": "filetest"}),
                               ("vnc-response", {"challenge": list(range(16))}),
                               ("forget-browser", {})]:
            for headers in [{"Origin": "https://attacker.invalid"},
                            {"Sec-Fetch-Site": "cross-site"}, {"X-NoVNC-Transfer": ""}]:
                self.assertEqual(self.request(endpoint, data, self.cookie, headers)[0], 403)

    def test_file_access_accepts_browser_session(self):
        self.assertEqual(self.request("list", cookie=self.cookie, method="GET")[0], 200)
        self.store.forget_browser(self.cookie)
        self.assertEqual(self.request("list", cookie=self.cookie, method="GET")[0], 401)
        file_token = self.store.authenticate("filetest", "test")
        self.assertEqual(self.request("list", cookie=gateway.COOKIE + "=" + file_token, method="GET")[0], 200)

    def test_uploads_can_be_copied_to_remote_file_clipboard(self):
        name = "文件 #1.txt"
        uploaded = self.store.root / name
        uploaded.write_bytes(b"bytes")
        (self.store.root / "link").symlink_to(uploaded)
        with patch.object(gateway, "desktop_selection") as clipboard:
            self.assertEqual(self.request("clipboard", {"paths": [name]})[0], 401)
            self.assertEqual(self.request("clipboard", {"paths": ["../passwd"]}, self.cookie)[0], 400)
            self.assertEqual(self.request("clipboard", {"paths": ["link"]}, self.cookie)[0], 403)
            clipboard.assert_not_called()
            self.assertEqual(self.request("clipboard", {"paths": [name]}, self.cookie)[0], 200)
            clipboard.assert_called_once_with(":98", [uploaded.as_uri().encode()])

    def test_republishing_an_upload_checks_the_original_file_revision(self):
        owner = self.store.session(self.cookie, browser=True)
        upload = self.store.create_upload(owner, {"name": "reply.pdf", "size": 4})
        with self.store.upload(upload["id"], owner) as (file, *_):
            file.write(b"file")
        completed = self.store.complete(upload["id"], owner)
        selection = {"paths": [completed["name"]], "revisions": [completed["revision"]]}
        with patch.object(gateway, "desktop_selection") as clipboard:
            self.assertEqual(self.request("clipboard", selection, self.cookie)[0], 200)
            self.assertEqual(self.request("clipboard", selection, self.cookie)[0], 200)
            uploaded = self.store.root / completed["name"]
            uploaded.write_bytes(b"changed")
            self.assertEqual(self.request("clipboard", selection, self.cookie)[0], 409)
            self.assertEqual(clipboard.call_count, 2)

    def test_remote_clipboard_download_is_bound_to_selection_and_session(self):
        copied = self.work / "远端 #2.txt"
        copied.write_bytes(b"original")
        symlink = self.work / "link"
        symlink.symlink_to(copied)
        uris = "\r\n".join([copied.as_uri(), copied.as_uri(), symlink.as_uri(),
                            self.work.as_uri(), "file://example.org/remote"]).encode()
        with patch.object(gateway, "desktop_selection", return_value=uris) as clipboard:
            self.assertEqual(self.request("clipboard-list")[0], 401)
            self.assertEqual(self.request("clipboard-list", cookie=self.cookie,
                                          headers={"Origin": "https://other.invalid"})[0], 403)
            clipboard.assert_not_called()
            status, data, _ = self.request("clipboard-list", cookie=self.cookie)
        self.assertEqual(status, 200)
        # The symlink is the same file, and the other host cannot be read
        self.assertEqual(data["skipped"], 1)
        self.assertEqual([item.get("folder", False) for item in data["files"]], [False, True])
        entry = data["files"][0]
        self.assertEqual((entry["name"], entry["size"]), (copied.name, 8))
        owner = self.store.session(self.cookie, browser=True)
        with self.store.clipboard_download(entry["id"], owner) as (file, name):
            self.assertEqual((name, file.read()), (copied.name, b"original"))
        self.assertEqual(self.request("clipboard-download?id=" + entry["id"], method="GET")[0], 401)
        other = self.store.authenticate("filetest", "other", browser=True)
        self.assertEqual(self.request("clipboard-download?id=" + entry["id"],
                                      cookie=gateway.BROWSER_COOKIE + "=" + other, method="GET")[0], 404)
        with patch.object(gateway.time, "time", return_value=gateway.time.time() + gateway.CLIPBOARD_SECONDS):
            self.assertEqual(self.request("clipboard-download?id=" + entry["id"],
                                          cookie=self.cookie, method="GET")[0], 404)
        copied.write_bytes(b"changed bytes")
        self.assertEqual(self.request("clipboard-download?id=" + entry["id"],
                                      cookie=self.cookie, method="GET")[0], 409)

    def test_copied_file_can_be_reached_through_a_folder_shortcut(self):
        real = self.work / "real"
        real.mkdir()
        (real / "报告.txt").write_bytes(b"content")
        shortcut = self.work / "shortcut"
        shortcut.symlink_to(real, target_is_directory=True)
        data = self.store.register_clipboard("owner", (shortcut / "报告.txt").as_uri().encode())
        self.assertEqual((data["skipped"], data["files"][0]["name"]), (0, "报告.txt"))
        with self.store.clipboard_download(data["files"][0]["id"], "owner") as (file, _name):
            self.assertEqual(file.read(), b"content")

    def test_copied_folder_downloads_as_zip_without_following_links(self):
        folder = self.work / "资料"
        (folder / "sub").mkdir(parents=True)
        (folder / "empty").mkdir()
        (folder / "sub" / "a.txt").write_bytes(b"alpha")
        secret = self.work / "outside.txt"
        secret.write_bytes(b"outside")
        (folder / "link.txt").symlink_to(secret)
        data = self.store.register_clipboard("owner", folder.as_uri().encode())
        entry = data["files"][0]
        self.assertEqual((entry["name"], entry["folder"]), ("资料.zip", True))
        self.assertEqual(self.store.clipboard_folder(entry["id"], "other"), None)
        self.assertEqual(self.store.clipboard_folder(entry["id"], "owner"), str(folder))
        handler = object.__new__(gateway.FileRequestHandler)
        handler.path = gateway.API + "clipboard-download"
        handler.request_version = "HTTP/1.1"
        handler.wfile = io.BytesIO()
        handler.send_response = handler.send_header = lambda *args: None
        handler.end_headers = lambda: None
        handler.send_folder(str(folder))
        chunks = io.BytesIO(handler.wfile.getvalue())
        body = b""
        while size := int(chunks.readline(), 16):
            body += chunks.read(size)
            chunks.read(2)
        self.assertEqual(chunks.read(), b"\r\n")
        with zipfile.ZipFile(io.BytesIO(body)) as archive:
            self.assertIsNone(archive.testzip())
            self.assertCountEqual(archive.namelist(), ["资料/sub/a.txt", "资料/empty/"])
            self.assertEqual(archive.read("资料/sub/a.txt"), b"alpha")

    def test_clipboard_watch_requires_session_and_registers_only_changed_files(self):
        copied = self.work / "copied.txt"
        copied.write_bytes(b"data")
        state = {"token": "a" * 32, "kind": "files", "uris": copied.as_uri().encode(), "changed": True}
        with patch.object(gateway, "clipboard_state", side_effect=lambda *_: dict(state)) as watch:
            self.assertEqual(self.request("clipboard-watch", cookie=None, method="GET")[0], 401)
            self.assertEqual(self.request("clipboard-watch?since=../x", cookie=self.cookie, method="GET")[0], 400)
            watch.assert_not_called()
            status, data, _ = self.request("clipboard-watch?since=" + "b" * 32, cookie=self.cookie, method="GET")
            self.assertEqual(status, 200)
            self.assertEqual([entry["name"] for entry in data["files"]], ["copied.txt"])
            self.assertNotIn("uris", data)
            state["changed"] = False
            _, data, _ = self.request("clipboard-watch", cookie=self.cookie, method="GET")
            self.assertNotIn("files", data)

    def post_image(self, body, cookie):
        return self.request("clipboard-image", cookie=cookie, raw=body,
                            headers={"Content-Type": "image/png"})

    def test_local_image_is_published_with_a_pasteable_file(self):
        png = gateway.PNG_SIGNATURE + b"pixels"
        with patch.object(gateway, "desktop_selection") as clipboard:
            self.assertEqual(self.post_image(png, None)[0], 401)
            self.assertEqual(self.post_image(b"not an image", self.cookie)[0], 415)
            clipboard.assert_not_called()
            self.assertEqual(self.post_image(png, self.cookie)[0], 200)
        saved = next((self.store.state / "clipboard").glob("*/clipboard-image.png"))
        self.assertEqual(saved.read_bytes(), png)
        clipboard.assert_called_once_with(":98", [saved.as_uri().encode()], saved, "image/png")

    def test_named_image_remains_a_file_and_keeps_its_clipboard_type(self):
        jpeg = b"\xff\xd8\xffjpeg"
        name = "照片.jpg"
        endpoint = "clipboard-image?name=" + quote(name)
        with patch.object(gateway, "desktop_selection") as clipboard:
            self.assertEqual(self.post_image(gateway.PNG_SIGNATURE + b"previous", self.cookie)[0], 200)
            self.assertEqual(self.request(endpoint, cookie=self.cookie, raw=jpeg,
                                          headers={"Content-Type": "image/jpeg"})[0], 200)
            self.assertEqual(self.request(endpoint, cookie=self.cookie, raw=jpeg + b"new",
                                          headers={"Content-Type": "image/jpeg"})[0], 200)
        saved, latest = [call.args[2] for call in clipboard.call_args_list[1:]]
        self.assertEqual(saved.name, name)
        self.assertNotEqual(saved, latest)
        self.assertEqual(saved.read_bytes(), jpeg)
        self.assertEqual(latest.read_bytes(), jpeg + b"new")
        self.assertEqual(clipboard.call_args.args, (":98", [latest.as_uri().encode()], latest, "image/jpeg"))

    def test_clipboard_image_requires_session(self):
        with patch.object(gateway, "clipboard_image", return_value=b"") as image:
            self.assertEqual(self.request("clipboard-image", method="GET")[0], 401)
            image.assert_not_called()
            self.assertEqual(self.request("clipboard-image", cookie=self.cookie, method="GET")[0], 404)

    @unittest.skipUnless(shutil.which("gio"), "requires GIO desktop trash")
    def test_trash_moves_regular_file_and_preserves_original_location(self):
        folder = self.store.root / "subfolder"
        folder.mkdir()
        source = folder / "-测试.txt"
        source.write_text("keep this content")
        listing = self.store.listing("subfolder")
        data = {"path": "subfolder/-测试.txt", "revision": listing["entries"][0]["trashId"]}
        data_home = self.work / "share"
        with patch.dict(os.environ, {"XDG_DATA_HOME": str(data_home), "GIO_USE_VFS": "local"}):
            self.assertEqual(self.request("trash", data)[0], 401)
            self.assertEqual(self.request("trash", data, self.cookie,
                                          {"Origin": "https://elsewhere.invalid"})[0], 403)
            self.assertEqual(self.request("trash", data, self.cookie)[0], 200)
            self.assertEqual(self.request("trash", data, self.cookie)[0], 404)
            self.assertFalse(source.exists())
            source.write_text("new file with the same name")
            data["revision"] = self.store.listing("subfolder")["entries"][0]["trashId"]
            self.assertEqual(self.request("trash", data, self.cookie)[0], 200)
        trash = data_home / "Trash"
        self.assertCountEqual([file.read_text() for file in (trash / "files").iterdir()],
                              ["keep this content", "new file with the same name"])
        for info in (trash / "info").iterdir():
            self.assertIn("Path=" + quote(str(source)) + "\n", info.read_text())

    def test_trash_rejects_stale_file_and_unavailable_trash_leaves_file(self):
        source = self.store.root / "original"
        source.write_text("old")
        data = {"path": "original", "revision": self.store.listing("")["entries"][0]["trashId"]}
        source.write_text("changed after listing")
        self.assertEqual(self.request("trash", data, self.cookie)[:2],
                         (409, {"error": "file_changed"}))
        data["revision"] = self.store.listing("")["entries"][0]["trashId"]
        link = self.store.root / "symlink"
        link.symlink_to(source)
        for url in ("../passwd", "symlink", ".novnc-uploads"):
            self.assertIn(self.request("trash", {**data, "path": url}, self.cookie)[0], (400, 403))
        with patch.object(gateway.subprocess, "run", side_effect=FileNotFoundError("gio")):
            self.assertEqual(self.request("trash", data, self.cookie)[:2],
                             (409, {"error": "trash_unavailable"}))
        self.assertEqual(source.read_text(), "changed after listing")


EXPECTED_RESPONSE = [164, 243, 185, 9, 27, 224, 215, 76, 65, 64, 169, 69, 199, 91, 6, 146]

if __name__ == "__main__":
    unittest.main()
