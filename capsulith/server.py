# SPDX-License-Identifier: GPL-2.0-only
"""Loopback studio and bounded binary-analysis API. No guest execution RPC."""

import json
import mimetypes
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

from .export import export_zip
from .resources import resource_root

MAX_BODY = 48 * 1024 * 1024
MAX_OBJECT_EXPORT_BODY = 96 * 1024 * 1024
ANALYSIS_SLOTS = threading.BoundedSemaphore(2)


def analyze(request):
    # File-backed pipes avoid accumulating an unbounded response in host RAM.
    with (
        tempfile.TemporaryFile() as input_file,
        tempfile.TemporaryFile() as output_file,
    ):
        input_file.write(json.dumps(request).encode())
        input_file.seek(0)
        subprocess.run(
            [sys.executable, "-m", "capsulith.worker"],
            stdin=input_file,
            stdout=output_file,
            stderr=subprocess.DEVNULL,
            timeout=20,
            check=False,
        )
        output_file.seek(0)
        raw = output_file.read(64 * 1024 * 1024 + 1)
    if len(raw) > 64 * 1024 * 1024:
        raise ValueError("Analysis response exceeds limit")
    try:
        response = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        raise ValueError("Analysis worker failed without a valid response") from None
    if not response.get("ok"):
        raise ValueError(response.get("error", "Analysis failed"))
    return response["result"]


class StudioServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False

    def __init__(self, *args, **kwargs):
        self.connections = threading.BoundedSemaphore(16)
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        if not self.connections.acquire(blocking=False):
            try:
                request.settimeout(0.5)
                request.sendall(
                    b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.connections.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "Capsulith/0.3"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, fmt, *args):
        pass

    def send(self, status, body, content_type="application/json", download=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        )
        if download:
            filename = download if isinstance(download, str) else "capsule-portable.zip"
            self.send_header(
                "Content-Disposition", f'attachment; filename="{filename}"'
            )
        self.end_headers()
        self.wfile.write(body)

    def allowed(self):
        port = self.server.server_address[1]
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        return host in hosts and (origin is None or origin == f"http://{host}")

    def do_GET(self):
        if not self.allowed():
            self.send(403, {"error": "Host or origin is not allowed"})
            return
        path = unquote(urlsplit(self.path).path)
        root = resource_root()
        if path == "/api/examples":
            self.send(200, json.loads((root / "examples" / "studio.json").read_text()))
            return
        if path == "/api/object-example":
            example = root / "examples" / "native-objects" / "studio.json"
            if not example.is_file():
                self.send(404, {"error": "Native object example is not installed"})
                return
            self.send(200, json.loads(example.read_text()))
            return
        if path == "/":
            target = root / "studio" / "index.html"
        elif path in (
            "/examples/qoi/module.json",
            "/examples/qoi/orbit.qoi",
            "/examples/qoi/orbit.png",
            "/THIRD_PARTY_NOTICES.md",
            "/LICENSE",
        ):
            target = root / path.lstrip("/")
        elif path.startswith(("/studio/", "/runtime/")):
            target = (root / path.lstrip("/")).resolve()
            if not target.is_relative_to(root.resolve()) or ".." in path.split("/"):
                self.send(404, {"error": "Not found"})
                return
        elif path in ("/app.js", "/styles.css", "/favicon.svg"):
            target = root / "studio" / path[1:]
        else:
            self.send(404, {"error": "Not found"})
            return
        if not target.is_file():
            self.send(404, {"error": "Not found"})
            return
        kind = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if target.suffix in (".js", ".mjs", ".cjs"):
            kind = "text/javascript"
        self.send(200, target.read_bytes(), kind)

    def do_POST(self):
        if not ANALYSIS_SLOTS.acquire(blocking=False):
            self.close_connection = True
            self.send(429, {"error": "Two requests are already processing"})
            return
        try:
            self._post()
        finally:
            ANALYSIS_SLOTS.release()

    def _post(self):
        if not self.allowed():
            self.send(403, {"error": "Host or origin is not allowed"})
            return
        try:
            path = urlsplit(self.path).path
            if path not in (
                "/api/inspect",
                "/api/extract",
                "/api/export",
                "/api/extract-module",
                "/api/export-module",
            ):
                self.send(404, {"error": "Not found"})
                return
            length = int(self.headers.get("Content-Length", "-1"))
            body_limit = (
                MAX_OBJECT_EXPORT_BODY if path == "/api/export-module" else MAX_BODY
            )
            if not 0 <= length <= body_limit:
                self.send(
                    413, {"error": f"Request exceeds {body_limit // (1024 * 1024)} MiB"}
                )
                return
            if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                self.send(415, {"error": "JSON content type required"})
                return
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete request")
            request = json.loads(raw)
            if not isinstance(request, dict):
                raise TypeError("Request must be an object")
            if path == "/api/export":
                data = export_zip(request["capsule"], request["inputs"])
                self.send(200, data, "application/zip", download=True)
            elif path == "/api/export-module":
                from .object_export import export_module_zip

                data = export_module_zip(request["module"], request.get("checkpoint"))
                self.send(
                    200, data, "application/zip", download="native-object-portable.zip"
                )
            else:
                request["action"] = {
                    "/api/inspect": "inspect",
                    "/api/extract": "extract",
                    "/api/extract-module": "module",
                }[path]
                self.send(200, analyze(request))
        except subprocess.TimeoutExpired:
            self.send(422, {"error": "Analysis stopped at the 20-second limit"})
        except (ValueError, KeyError, TypeError, TimeoutError) as error:
            self.send(422, {"error": str(error)})


def serve(port=6359):
    with StudioServer(("127.0.0.1", port), Handler) as server:
        print(
            f"Capsulith Studio: http://127.0.0.1:{server.server_address[1]}/",
            flush=True,
        )
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
