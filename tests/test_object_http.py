# SPDX-License-Identifier: GPL-2.0-only
import base64
import http.client
import io
import json
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from test_module import ARTIFACT, ENTRIES
from test_object_integration import create_checkpoint

from capsulith.server import ANALYSIS_SLOTS, Handler, StudioServer


class ObjectHTTPTests(unittest.TestCase):
    def setUp(self):
        self.server = StudioServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, path, value=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=25)
        defaults = {"Content-Type": "application/json"} if value is not None else {}
        defaults.update(headers or {})
        connection.request(
            "POST" if value is not None else "GET",
            path,
            body=json.dumps(value) if value is not None else None,
            headers=defaults,
        )
        response = connection.getresponse()
        result = response.status, response.read(), dict(response.getheaders())
        connection.close()
        return result

    def test_object_example_exact_data_and_missing_specimen(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            example = root / "examples/native-objects/studio.json"
            example.parent.mkdir(parents=True)
            value = {
                "module": {"schema": "capsulith.module.v1"},
                "packets": {},
                "expected": {},
                "nativeContext": "test route fixture",
            }
            example.write_text(json.dumps(value))
            with patch("capsulith.server.resource_root", return_value=root):
                status, raw, _ = self.request("/api/object-example")
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(raw), value)
                example.unlink()
                self.assertEqual(self.request("/api/object-example")[0], 404)

    def test_actual_module_extraction_and_portable_download(self):
        request = {
            "artifact": base64.b64encode(ARTIFACT.read_bytes()).decode(),
            "methods": ENTRIES,
            "action": "inspect",
        }
        status, raw, _ = self.request("/api/extract-module", request)
        self.assertEqual(status, 200, raw)
        module = json.loads(raw)
        self.assertEqual(module["schema"], "capsulith.module.v1")
        status, raw, headers = self.request("/api/export-module", {"module": module})
        self.assertEqual(status, 200, raw[:500])
        self.assertEqual(headers["Content-Type"], "application/zip")
        self.assertEqual(
            headers["Content-Disposition"],
            'attachment; filename="native-object-portable.zip"',
        )
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            self.assertEqual(json.loads(archive.read("module.json")), module)
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source = folder / "module.json"
            source.write_text(json.dumps(module))
            checkpoint = create_checkpoint(source, folder / "checkpoint.json")
            status, raw, _ = self.request(
                "/api/export-module", {"module": module, "checkpoint": checkpoint}
            )
            self.assertEqual(status, 200, raw[:500])
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                self.assertEqual(
                    json.loads(archive.read("checkpoint.json")), checkpoint
                )
        request["methods"] = {"prototype": ENTRIES["create"]}
        status, raw, _ = self.request("/api/extract-module", request)
        self.assertEqual(status, 422)
        self.assertIn("reserved", json.loads(raw)["error"])

    def test_new_routes_preserve_existing_request_controls(self):
        self.assertEqual(
            self.request("/api/object-example", headers={"Host": "foreign.example"})[0],
            403,
        )
        self.assertEqual(
            self.request(
                "/api/extract-module", {}, {"Origin": "https://foreign.example"}
            )[0],
            403,
        )
        self.assertEqual(
            self.request("/api/export-module", {}, {"Content-Type": "text/plain"})[0],
            415,
        )
        self.assertEqual(
            self.request(
                "/api/extract-module", {}, {"Content-Length": str(48 * 1024 * 1024 + 1)}
            )[0],
            413,
        )
        self.assertEqual(
            self.request(
                "/api/export-module", {}, {"Content-Length": str(96 * 1024 * 1024 + 1)}
            )[0],
            413,
        )
        ANALYSIS_SLOTS.acquire()
        ANALYSIS_SLOTS.acquire()
        try:
            self.assertEqual(self.request("/api/export-module", {})[0], 429)
        finally:
            ANALYSIS_SLOTS.release()
            ANALYSIS_SLOTS.release()


if __name__ == "__main__":
    unittest.main()
