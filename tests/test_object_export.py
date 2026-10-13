# SPDX-License-Identifier: GPL-2.0-only
import hashlib
import io
import json
import unittest
import zipfile
from pathlib import Path

from capsulith.object_export import export_module_zip
from capsulith.resources import resource_root


class ObjectExportTests(unittest.TestCase):
    def setUp(self):
        self.module = json.loads(
            (Path(__file__).parent / "fixtures/native-objects/module.json").read_text()
        )

    def test_manifest_and_portable_sources_have_exact_bytes_and_permissions(self):
        with zipfile.ZipFile(io.BytesIO(export_module_zip(self.module))) as archive:
            self.assertIsNone(archive.testzip())
            names = archive.namelist()
            self.assertEqual(len(names), len(set(names)))
            self.assertFalse(any(n.endswith((".dylib", ".pyc")) for n in names))
            self.assertIn("runtime/vendor/unicorn_aarch64.js", names)
            self.assertIn("runtime/vendor/unicorn-js-source-2.1.4.tar.gz", names)
            self.assertIn("runtime/object-cli.cjs", names)
            self.assertIn(b'data-portable="true"', archive.read("studio/objects.html"))
            self.assertIsNone(
                json.loads(archive.read("portable.json"))["checkpointFile"]
            )
            manifest = json.loads(archive.read("manifest.json"))
            self.assertEqual(
                set(names) - {"manifest.json"}, {f["path"] for f in manifest["files"]}
            )
            for entry in manifest["files"]:
                data = archive.read(entry["path"])
                self.assertEqual(len(data), entry["bytes"])
                self.assertEqual(hashlib.sha256(data).hexdigest(), entry["sha256"])
                self.assertEqual(
                    (archive.getinfo(entry["path"]).external_attr >> 16) & 0o777,
                    entry["mode"],
                )
                self.assertFalse(Path(entry["path"]).is_absolute())
                self.assertNotIn("..", Path(entry["path"]).parts)
                if entry["path"].startswith("runtime/"):
                    self.assertEqual(
                        data, (resource_root() / entry["path"]).read_bytes()
                    )

    def test_identity_and_unmatched_or_unbound_snapshots_refused(self):
        altered = json.loads(json.dumps(self.module))
        altered["entries"]["create"]["entry"] += 4
        with self.assertRaisesRegex(ValueError, "identity"):
            export_module_zip(altered)
        checkpoint = {
            "schema": "capsulith.checkpoint.v1",
            "moduleId": self.module["id"],
            "modelVersion": self.module["modelVersion"],
        }
        with self.assertRaisesRegex(ValueError, "limits"):
            export_module_zip(self.module, checkpoint)
        checkpoint["limits"] = {}
        checkpoint["digest"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "digest"):
            export_module_zip(self.module, checkpoint)


if __name__ == "__main__":
    unittest.main()
