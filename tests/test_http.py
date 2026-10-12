# SPDX-License-Identifier: GPL-2.0-only
import http.client
import json
import threading
import unittest
from capsulith.server import Handler, StudioServer, ANALYSIS_SLOTS


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
