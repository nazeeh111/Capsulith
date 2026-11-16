# SPDX-License-Identifier: GPL-2.0-only
import http.client
import json
import threading
import unittest
from unittest import mock

from capsulith.resources import resource_root
from capsulith.server import ANALYSIS_SLOTS, Handler, StudioServer


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.server = StudioServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(
            "POST" if body is not None else "GET",
            path,
            body=body,
            headers=headers or {},
        )
        response = connection.getresponse()
        result = (response.status, response.read())
        connection.close()
        return result

    def test_actual_assets_examples_and_origin_boundary(self):
        status, raw = self.request("/api/examples")
        self.assertEqual(status, 200)
        examples = json.loads(raw)
        self.assertEqual(len(examples), 2)
        self.assertEqual(self.request("/runtime/browser.mjs")[0], 200)
        self.assertEqual(
            self.request("/api/examples", headers={"Host": "foreign.example"})[0], 403
        )
        self.assertEqual(
            self.request(
                "/api/examples", headers={"Origin": "https://foreign.example"}
            )[0],
            403,
        )
        self.assertEqual(self.request("/runtime/../../pyproject.toml")[0], 404)

    def test_request_quotas_reject_before_body_read(self):
        self.assertEqual(
            self.request("/api/inspect", "{}", {"Content-Type": "text/plain"})[0], 415
        )
        self.assertEqual(
            self.request(
                "/api/inspect",
                "{}",
                {
                    "Content-Type": "application/json",
                    "Content-Length": str(48 * 1024 * 1024 + 1),
                },
            )[0],
            413,
        )
        ANALYSIS_SLOTS.acquire()
        ANALYSIS_SLOTS.acquire()
        try:
            self.assertEqual(
                self.request("/api/export", "{}", {"Content-Type": "application/json"})[
                    0
                ],
                429,
            )
        finally:
            ANALYSIS_SLOTS.release()
            ANALYSIS_SLOTS.release()

    def test_image_journey_assets_match_installed_files_and_preserve_route_bounds(self):
        for name in (
            "studio/image.html",
            "studio/image-codec.mjs",
            "studio/image-codec-core.mjs",
            "examples/qoi/module.json",
            "examples/qoi/orbit.qoi",
            "examples/qoi/orbit.png",
            "LICENSE",
        ):
            status, data = self.request("/" + name)
            self.assertEqual(status, 200, name)
            self.assertEqual(data, (resource_root() / name).read_bytes())
        self.assertEqual(self.request("/examples/qoi/libqoi.dylib")[0], 404)
        self.assertEqual(self.request("/examples/qoi/../../pyproject.toml")[0], 404)
        self.assertEqual(
            self.request(
                "/examples/qoi/module.json", headers={"Host": "foreign.example"}
            )[0],
            403,
        )
        self.assertEqual(
            self.request(
                "/examples/qoi/orbit.qoi", headers={"Origin": "https://foreign.example"}
            )[0],
            403,
        )


class LoopbackBindTests(unittest.TestCase):
    def test_numeric_bind_needs_no_reverse_lookup_and_keeps_http_boundaries(self):
        # A numeric loopback service must start even when reverse DNS is unavailable.
        with mock.patch("socket.getfqdn", side_effect=AssertionError("reverse lookup forbidden")) as lookup:
            with StudioServer(("127.0.0.1", 0), Handler) as server:
                self.assertEqual(server.server_name, "127.0.0.1")
                self.assertEqual(server.server_port, server.server_address[1])
                self.assertGreater(server.server_port, 0)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                    try:
                        connection.request("GET", "/")
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.read(), (resource_root() / "studio/index.html").read_bytes())
                        self.assertIn("worker-src 'self'", response.headers["Content-Security-Policy"])
                        connection.request("GET", "/api/meta", headers={"Origin": "https://foreign.example"})
                        response = connection.getresponse()
                        self.assertEqual(response.status, 403)
                        self.assertEqual(json.loads(response.read())["error"], "Host or origin is not allowed")
                    finally:
                        connection.close()
                finally:
                    server.shutdown()
                    thread.join(timeout=5)
                    self.assertFalse(thread.is_alive())
            lookup.assert_not_called()
