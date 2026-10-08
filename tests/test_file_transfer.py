"""Exercise the file API over HTTP, including its authentication and confinement."""
import hashlib
import http.client
import importlib.util
import json
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.parse import urlencode

REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("gateway", REPO / "utils/novnc_gateway.py")
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class FileAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="novnc-files-test-")
        cls.work = Path(cls.temp.name)
        cls.root = cls.work / "files"
        cls.password_file = cls.work / "passwd"
        # Generate the fixture with TigerVNC, independently of our decryptor.
        password = subprocess.run(["tigervncpasswd", "-f"], input=b"filetest\n",
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  check=True).stdout
        cls.password_file.write_bytes(password)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.log = (cls.work / "gateway.log").open("w")
        cls.process = subprocess.Popen([
            sys.executable, str(REPO / "utils/novnc_gateway.py"),
            "--listen", "127.0.0.1", "--port", str(cls.port),
            "--files", str(cls.root), "--state", str(cls.work / "state"),
            "--password-file", str(cls.password_file),
        ], stdout=cls.log, stderr=cls.log)
        for _ in range(100):
            try:
                with socket.create_connection(("127.0.0.1", cls.port), timeout=0.2):
                    return
            except OSError:
                if cls.process.poll() is not None:
                    raise RuntimeError((cls.work / "gateway.log").read_text())
                time.sleep(0.05)
        raise RuntimeError("Gateway did not start")

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.wait(timeout=10)
        cls.log.close()
        cls.temp.cleanup()

    def setUp(self):
        self.cookie = None
        status, headers, data = self.request("POST", "session", data={"password": "filetest"})
        self.assertEqual(status, 200)
        self.cookie = headers["Set-Cookie"].split(";", 1)[0]

    def tearDown(self):
        with sqlite3.connect(self.work / "state/auth.sqlite3") as db:
            db.execute("DELETE FROM failures")

    def request(self, method, endpoint, params=None, data=None, body=None,
                headers=None, auth=True, raw=False):
        request_headers = {"X-NoVNC-Transfer": "1"}
        if auth and self.cookie:
            request_headers["Cookie"] = self.cookie
        if data is not None:
            body = json.dumps(data).encode()
            request_headers["Content-Type"] = "application/json"
        if headers:
            request_headers.update(headers)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        path = gateway.API + endpoint
        if params:
            path += "?" + urlencode(params)
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        status, reply_headers = response.status, dict(response.getheaders())
        content = response.read()
        connection.close()
        return status, reply_headers, content if raw else json.loads(content)

    def create(self, name, content, path=""):
        status, _, data = self.request("POST", "upload",
                                       data={"name": name, "size": len(content), "path": path})
        self.assertEqual(status, 201)
        return data["id"]

    def send(self, upload_id, content, offset=0):
        return self.request("PUT", "upload", {"id": upload_id, "offset": offset}, body=content)

    def test_authentication_and_origin(self):
        self.assertEqual(self.request("GET", "list", auth=False)[0], 401)
        self.assertEqual(self.request("GET", "list", headers={"Cookie": self.cookie + "bad"})[0], 401)
        self.assertEqual(self.request("POST", "session", data={"password": "wrong"})[0], 401)
        self.assertEqual(self.request("POST", "session", data={"password": "filetest"},
                                      headers={"Origin": "https://attacker.invalid"})[0], 403)
        self.assertEqual(self.request("POST", "session", data={"password": "filetest"},
                                      headers={"X-NoVNC-Transfer": ""})[0], 403)
        self.assertEqual(self.request("GET", "list", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        status, headers, _ = self.request("POST", "session", data={"password": "filetest"},
                                         headers={"X-Forwarded-Proto": "https"})
        self.assertEqual(status, 200)
        for attribute in ["HttpOnly", "SameSite=Strict", "Secure", "Path=/api/files/"]:
            self.assertIn(attribute, headers["Set-Cookie"])
        self.assertIn("no-store", headers["Cache-Control"])

    def test_unicode_chunked_roundtrip_and_duplicate_names(self):
        name = "测试文件😀.bin"
        content = bytes(range(256)) * (gateway.CHUNK_SIZE // 256 + 11)
        first = self.create(name, content)
        self.assertEqual(self.send(first, content[:gateway.CHUNK_SIZE])[0], 200)
        self.assertEqual(self.send(first, content[gateway.CHUNK_SIZE:], gateway.CHUNK_SIZE)[0], 200)
        status, _, result = self.request("POST", "complete", {"id": first}, data={})
        self.assertEqual((status, result["name"]), (200, name))
        status, headers, downloaded = self.request("GET", "download", {"path": name}, raw=True)
        self.assertEqual(status, 200)
        self.assertEqual(hashlib.sha256(downloaded).digest(), hashlib.sha256(content).digest())
        self.assertIn("filename*=UTF-8", headers["Content-Disposition"])
        duplicate = self.create(name, b"other")
        self.send(duplicate, b"other")
        _, _, result = self.request("POST", "complete", {"id": duplicate}, data={})
        self.assertEqual(result["name"], "测试文件😀 (1).bin")
        self.assertEqual((self.root / name).read_bytes(), content)

    def test_zero_length_and_subfolders(self):
        (self.root / "subfolder").mkdir()
        upload_id = self.create("empty.txt", b"", "subfolder")
        self.assertEqual(self.request("POST", "complete", {"id": upload_id}, data={})[0], 200)
        status, _, listing = self.request("GET", "list", {"path": "subfolder"})
        self.assertEqual(status, 200)
        self.assertEqual(listing["entries"][0]["name"], "empty.txt")
        self.assertEqual(self.request("GET", "download", {"path": "subfolder/empty.txt"}, raw=True)[2], b"")

    def test_confined_paths_and_symlinks(self):
        (self.root / "outside").symlink_to(self.work, target_is_directory=True)
        (self.root / "secret").symlink_to(self.password_file)
        for path in ["../passwd", "/etc/passwd", "a/../../passwd", ".novnc-uploads", "a\\..\\passwd"]:
            self.assertEqual(self.request("GET", "list", {"path": path})[0], 400)
        self.assertEqual(self.request("GET", "list", {"path": "outside"})[0], 403)
        self.assertEqual(self.request("GET", "download", {"path": "secret"})[0], 403)
        self.assertEqual(self.request("POST", "upload", data={"name": "../escaped", "size": 0})[0], 400)
        listing = self.request("GET", "list")[2]
        names = [item["name"] for item in listing["entries"]]
        self.assertNotIn("outside", names)
        self.assertNotIn("secret", names)
        self.assertNotIn(".novnc-uploads", names)

    def test_upload_owner_and_incomplete_cancel(self):
        upload_id = self.create("partial.txt", b"test")
        self.assertEqual(self.request("POST", "complete", {"id": upload_id}, data={})[0], 409)
        self.assertEqual(self.send(upload_id, b"te", 1)[0], 409)
        self.assertEqual(self.send(upload_id, b"te")[0], 200)
        self.assertEqual(self.request("GET", "upload", {"id": upload_id})[2]["offset"], 2)
        _, headers, _ = self.request("POST", "session", data={"password": "filetest"})
        second_cookie = headers["Set-Cookie"].split(";", 1)[0]
        self.assertEqual(self.request("POST", "cancel", {"id": upload_id}, data={},
                                      headers={"Cookie": second_cookie})[0], 403)
        self.assertEqual(self.request("GET", "upload", {"id": upload_id},
                                      headers={"Cookie": second_cookie})[0], 403)
        self.assertEqual(self.request("POST", "cancel", {"id": upload_id}, data={})[0], 200)
        self.assertFalse((self.root / "partial.txt").exists())
        self.assertFalse((self.root / ".novnc-uploads" / (upload_id + ".part")).exists())

    def test_truncated_chunk_rolls_back(self):
        upload_id = self.create("truncated.txt", b"abcde")
        connection = socket.create_connection(("127.0.0.1", self.port))
        request = (f"PUT /api/files/upload?id={upload_id}&offset=0 HTTP/1.1\r\n"
                   f"Host: 127.0.0.1:{self.port}\r\nCookie: {self.cookie}\r\n"
                   "X-NoVNC-Transfer: 1\r\nContent-Length: 5\r\n\r\nab")
        connection.sendall(request.encode())
        connection.shutdown(socket.SHUT_WR)
        while connection.recv(4096):
            pass
        connection.close()
        self.assertEqual(self.send(upload_id, b"abcde")[0], 200)
        self.assertEqual(self.request("POST", "complete", {"id": upload_id}, data={})[0], 200)
        self.assertEqual((self.root / "truncated.txt").read_bytes(), b"abcde")

    def test_size_limit(self):
        self.assertEqual(self.request("POST", "upload",
                                      data={"name": "huge.bin", "size": gateway.MAX_FILE_SIZE + 1})[0], 413)
        upload_id = self.create("too-much.bin", b"tiny")
        self.assertEqual(self.send(upload_id, b"large")[0], 409)
        self.assertEqual(self.request("POST", "cancel", {"id": upload_id}, data={})[0], 200)

    def test_wrong_password_rate_limit(self):
        for _ in range(10):
            self.assertEqual(self.request("POST", "session", data={"password": "wrong"})[0], 401)
        self.assertEqual(self.request("POST", "session", data={"password": "wrong"})[0], 429)


if __name__ == "__main__":
    unittest.main()
