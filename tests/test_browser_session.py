"""Test persistent browser sessions and API routes without starting a server."""
from email.message import Message
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

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

    def request(self, endpoint, data=None, cookie=None, headers=None, method="POST"):
        handler = object.__new__(gateway.FileRequestHandler)
        handler.server = SimpleNamespace(file_store=self.store)
        handler.path = gateway.API + endpoint
        handler.command = method
        handler.client_address = ("127.0.0.1", 12345)
        handler.connection = SimpleNamespace(settimeout=lambda value: None)
        body = json.dumps(data or {}).encode()
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


EXPECTED_RESPONSE = [164, 243, 185, 9, 27, 224, 215, 76, 65, 64, 169, 69, 199, 91, 6, 146]

if __name__ == "__main__":
    unittest.main()
