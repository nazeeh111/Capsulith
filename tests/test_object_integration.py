# SPDX-License-Identifier: GPL-2.0-only
import base64
import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from test_module import ARTIFACT, ENTRIES


def create_checkpoint(module_path, checkpoint_path):
    runtime = Path(__file__).resolve().parents[1] / "runtime/objects.cjs"
    script = """
const fs = require('node:fs');
const {createModule} = require(process.argv[1]);
(async () => {
  const instance = await createModule(JSON.parse(fs.readFileSync(process.argv[2])));
  try {
    const created = await instance.call('create', []);
    const checkpoint = await instance.checkpoint();
    fs.writeFileSync(process.argv[3], JSON.stringify(checkpoint), {flag:'wx'});
    await instance.call('free', [created.returnValue]);
  } finally { await instance.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
"""
    subprocess.run(
        ["node", "-e", script, str(runtime), str(module_path), str(checkpoint_path)],
        check=True,
        capture_output=True,
        timeout=15,
    )
    return json.loads(checkpoint_path.read_text())


from capsulith.cli import main
from capsulith.server import analyze


class ObjectIntegrationTests(unittest.TestCase):
    def test_bounded_worker_extracts_actual_module_and_refuses_bad_methods(self):
        request = {
            "action": "module",
            "artifact": base64.b64encode(ARTIFACT.read_bytes()).decode(),
            "methods": ENTRIES,
        }
        module = analyze(request)
        self.assertEqual(module["schema"], "capsulith.module.v1")
        self.assertEqual(set(module["entries"]), set(ENTRIES))
        self.assertEqual(module["entries"]["create"]["entry"], 0x1580)
        request["methods"] = {"constructor": ENTRIES["create"]}
        with self.assertRaisesRegex(ValueError, "reserved"):
            analyze(request)

    def test_module_cli_creates_and_never_overwrites_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            methods = folder / "methods.json"
            methods.write_text(json.dumps(ENTRIES))
            output = folder / "module.json"
            command = [
                "capsulith",
                "module",
                str(ARTIFACT),
                "--methods",
                str(methods),
                "--out",
                str(output),
            ]
            with (
                patch.object(sys, "argv", command),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(main(), 0)
            expected = output.read_bytes()
            self.assertEqual(json.loads(expected)["schema"], "capsulith.module.v1")
            with (
                patch.object(sys, "argv", command),
                contextlib.redirect_stderr(io.StringIO()),
            ):
                self.assertEqual(main(), 1)
            self.assertEqual(output.read_bytes(), expected)

    def test_export_module_cli_uses_actual_exporter_and_no_clobber(self):
        request = {
            "action": "module",
            "artifact": base64.b64encode(ARTIFACT.read_bytes()).decode(),
            "methods": ENTRIES,
        }
        module = analyze(request)
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source, output = folder / "module.json", folder / "object.zip"
            source.write_text(json.dumps(module))
            command = ["capsulith", "export-module", str(source), "--out", str(output)]
            with (
                patch.object(sys, "argv", command),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(main(), 0)
            expected = output.read_bytes()
            with zipfile.ZipFile(io.BytesIO(expected)) as archive:
                self.assertEqual(json.loads(archive.read("module.json")), module)
                self.assertFalse(
                    any(name.endswith(".dylib") for name in archive.namelist())
                )
            with (
                patch.object(sys, "argv", command),
                contextlib.redirect_stderr(io.StringIO()),
            ):
                self.assertEqual(main(), 1)
            self.assertEqual(output.read_bytes(), expected)

    def test_export_module_cli_includes_explicit_actual_checkpoint(self):
        module = analyze(
            {
                "action": "module",
                "artifact": base64.b64encode(ARTIFACT.read_bytes()).decode(),
                "methods": ENTRIES,
            }
        )
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            source, checkpoint_path, output = (
                folder / "module.json",
                folder / "checkpoint.json",
                folder / "object.zip",
            )
            source.write_text(json.dumps(module))
            checkpoint = create_checkpoint(source, checkpoint_path)
            command = [
                "capsulith",
                "export-module",
                str(source),
                "--checkpoint",
                str(checkpoint_path),
                "--out",
                str(output),
            ]
            with (
                patch.object(sys, "argv", command),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(main(), 0)
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(
                    json.loads(archive.read("checkpoint.json")), checkpoint
                )


if __name__ == "__main__":
    unittest.main()
