# SPDX-License-Identifier: GPL-2.0-only
import base64
import io
import json
from pathlib import Path
import unittest
import zipfile
from capsulith.server import analyze
from capsulith.export import export_zip

ROOT = Path(__file__).resolve().parents[1]


class DeliveryTests(unittest.TestCase):
    def test_actual_subprocess_inventory_and_extract(self):
        request = {
            "artifact": base64.b64encode(
                (ROOT / "examples/xxhash/libxxhash-o2.dylib").read_bytes()
            ).decode(),
            "action": "inspect",
        }
        metadata = analyze(request)
        self.assertTrue(any(f["name"] == "_XXH32" for f in metadata["functions"]))
        request.update(action="extract", root="_XXH32")
        capsule = analyze(request)
        self.assertEqual(capsule["extraction"]["codeBytes"], 308)
        self.assertEqual(capsule["imports"], [])
        request["artifact"] = "!not-base64!"
        with self.assertRaises(ValueError):
            analyze(request)

    def test_portable_contains_original_bytes_source_and_runner(self):
        capsule = json.loads(
            (ROOT / "examples/xxhash/xxh32-o2.capsule.json").read_text()
        )
        inputs = json.loads((ROOT / "examples/xxhash/input.json").read_text())
        data = export_zip(capsule, inputs)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            self.assertEqual(json.loads(archive.read("capsule.json")), capsule)
            self.assertEqual(json.loads(archive.read("inputs.json")), inputs)
            self.assertIn(
                "runtime/vendor/unicorn-js-source-2.1.4.tar.gz", archive.namelist()
            )
            self.assertEqual(
                archive.read("runtime/vendor/unicorn_aarch64.js"),
                (ROOT / "runtime/vendor/unicorn_aarch64.js").read_bytes(),
            )
            self.assertIn("run.cjs", archive.namelist())
            for specimen in ("lz4", "xxhash"):
                self.assertEqual(
                    archive.read(f"licenses/{specimen}-BSD-2-Clause.txt"),
                    (ROOT / "examples" / specimen / "LICENSE").read_bytes(),
                )
            self.assertFalse(
                any(name.endswith(".dylib") for name in archive.namelist())
            )
