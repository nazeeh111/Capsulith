# SPDX-License-Identifier: GPL-2.0-only
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from capsulith.cli import main

ROOT = Path(__file__).resolve().parents[1]
SPECIMEN = ROOT / "examples" / "xxhash"


class CLIOutputTests(unittest.TestCase):
    def invoke(self, command):
        stdout, stderr = io.StringIO(), io.StringIO()
        with (
            patch.object(sys, "argv", ["capsulith", *map(str, command)]),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            status = main()
        return status, stdout.getvalue(), stderr.getvalue()

    def prepare(self, folder, command):
        if command == "extract":
            first, second = folder / "artifact.dylib", folder / "contract.json"
            first.write_bytes((SPECIMEN / "libxxhash-o2.dylib").read_bytes())
            second.write_bytes((SPECIMEN / "contract.json").read_bytes())
            arguments = ["extract", first, "--root", "_XXH32", "--contract", second]
        else:
            first, second = folder / "capsule.json", folder / "inputs.json"
            first.write_bytes((SPECIMEN / "xxh32-o2.capsule.json").read_bytes())
            second.write_bytes((SPECIMEN / "input.json").read_bytes())
            arguments = ["export", first, "--inputs", second]
        return arguments, (first, second)

    def test_extract_and_export_refuse_every_input_alias(self):
        for command in ("extract", "export"):
            for input_index in (0, 1):
                for alias in ("direct", "normalized", "symlink", "hardlink"):
                    with (
                        self.subTest(command=command, input=input_index, alias=alias),
                        tempfile.TemporaryDirectory() as temporary,
                    ):
                        folder = Path(temporary)
                        arguments, inputs = self.prepare(folder, command)
                        original = [path.read_bytes() for path in inputs]
                        source = inputs[input_index]
                        output = folder / "output"
                        if alias == "direct":
                            output = source
                        elif alias == "normalized":
                            (folder / "sub").mkdir()
                            output = folder / "sub" / ".." / source.name
                        elif alias == "symlink":
                            output.symlink_to(source)
                        else:
                            output.hardlink_to(source)
                        status, stdout, stderr = self.invoke(
                            [*arguments, "--out", output]
                        )
                        self.assertEqual(status, 1)
                        self.assertEqual(stdout, "")
                        self.assertIn("Output must not replace an input", stderr)
                        self.assertEqual(
                            [path.read_bytes() for path in inputs], original
                        )
                        self.assertEqual(output.read_bytes(), original[input_index])

    @unittest.skipIf(sys.platform == "win32", "Requires POSIX file-size limits")
    def test_failed_export_write_preserves_previous_output_and_inputs(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            arguments, inputs = self.prepare(folder, "export")
            original = [path.read_bytes() for path in inputs]
            output = folder / "previous.zip"
            output.write_bytes(b"previous export")
            before = set(folder.iterdir())
            script = (
                "import resource;"
                "resource.setrlimit(resource.RLIMIT_FSIZE, (4096, 4096));"
                "from capsulith.cli import main;"
                "raise SystemExit(main())"
            )
            result = subprocess.run(
                [
                    sys.executable, "-c", script,
                    *map(str, [*arguments, "--out", output]),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("capsulith:", result.stderr)
            self.assertEqual(result.stdout, "")
            self.assertEqual(output.read_bytes(), b"previous export")
            self.assertEqual([path.read_bytes() for path in inputs], original)
            self.assertEqual(set(folder.iterdir()), before)

    def test_unrelated_outputs_are_replaceable_and_reopenable(self):
        for command in ("extract", "export"):
            for kind in ("new", "existing", "symlink", "dangling-symlink"):
                with (
                    self.subTest(command=command, output=kind),
                    tempfile.TemporaryDirectory() as temporary,
                ):
                    folder = Path(temporary)
                    arguments, inputs = self.prepare(folder, command)
                    original = [path.read_bytes() for path in inputs]
                    output = folder / "result"
                    target = folder / "referent" if "symlink" in kind else output
                    if kind in ("existing", "symlink"):
                        target.write_bytes(b"previous result")
                        target.chmod(0o640)
                    if "symlink" in kind:
                        output.symlink_to(target.name)
                    status, stdout, stderr = self.invoke(
                        [*arguments, "--out", output]
                    )
                    self.assertEqual(status, 0, stderr)
                    self.assertTrue(stdout)
                    self.assertEqual(stderr, "")
                    self.assertEqual([path.read_bytes() for path in inputs], original)
                    if "symlink" in kind:
                        self.assertTrue(output.is_symlink())
                        self.assertEqual(output.read_bytes(), target.read_bytes())
                    if os.name == "posix":
                        expected_mode = 0o640 if kind in ("existing", "symlink") else 0o600
                        self.assertEqual(target.stat().st_mode & 0o777, expected_mode)
                    if command == "extract":
                        capsule = json.loads(output.read_bytes())
                        self.assertEqual(capsule["extraction"]["codeBytes"], 308)
                        self.assertEqual(capsule["contract"], json.loads(original[1]))
                        self.assertEqual(
                            capsule["chunks"],
                            json.loads(
                                (SPECIMEN / "xxh32-o2.capsule.json").read_bytes()
                            )["chunks"],
                        )
                    else:
                        with zipfile.ZipFile(output) as archive:
                            self.assertIsNone(archive.testzip())
                            self.assertEqual(
                                json.loads(archive.read("capsule.json")),
                                json.loads(original[0]),
                            )
                            self.assertEqual(
                                json.loads(archive.read("inputs.json")),
                                json.loads(original[1]),
                            )
                            self.assertEqual(
                                archive.read("LICENSE"), (ROOT / "LICENSE").read_bytes()
                            )
                            self.assertIn("run.cjs", archive.namelist())
                    self.assertFalse(list(folder.glob(".capsulith-*.tmp")))

    def test_symlinked_inputs_and_parents_cannot_hide_aliases(self):
        for command in ("extract", "export"):
            for input_index in (0, 1):
                with (
                    self.subTest(command=command, input=input_index),
                    tempfile.TemporaryDirectory() as temporary,
                ):
                    folder = Path(temporary)
                    arguments, inputs = self.prepare(folder, command)
                    original = [path.read_bytes() for path in inputs]
                    source = inputs[input_index]
                    referent = folder / "original"
                    source.rename(referent)
                    source.symlink_to(referent.name)
                    parent_alias = folder / "parent-alias"
                    parent_alias.symlink_to(folder, target_is_directory=True)
                    output = parent_alias / referent.name
                    status, _, stderr = self.invoke([*arguments, "--out", output])
                    self.assertEqual(status, 1)
                    self.assertIn("Output must not replace an input", stderr)
                    self.assertEqual([path.read_bytes() for path in inputs], original)
                    self.assertTrue(source.is_symlink())
                    self.assertEqual(referent.read_bytes(), original[input_index])

    def test_filesystem_publication_failures_leave_no_partial_output(self):
        for command in ("extract", "export"):
            for boundary in ("fsync", "replace"):
                for existing in (False, True):
                    with (
                        self.subTest(
                            command=command, boundary=boundary, existing=existing
                        ),
                        tempfile.TemporaryDirectory() as temporary,
                    ):
                        folder = Path(temporary)
                        arguments, inputs = self.prepare(folder, command)
                        original = [path.read_bytes() for path in inputs]
                        output = folder / "result"
                        if existing:
                            output.write_bytes(b"last valid result")
                        before = set(folder.iterdir())
                        with patch.object(
                            os, boundary, side_effect=OSError("simulated storage failure")
                        ):
                            status, stdout, stderr = self.invoke(
                                [*arguments, "--out", output]
                            )
                        self.assertEqual(status, 1)
                        self.assertEqual(stdout, "")
                        self.assertIn("simulated storage failure", stderr)
                        self.assertEqual(set(folder.iterdir()), before)
                        self.assertEqual(
                            [path.read_bytes() for path in inputs], original
                        )
                        if existing:
                            self.assertEqual(output.read_bytes(), b"last valid result")
                        else:
                            self.assertFalse(output.exists())

    def test_invalid_companion_json_does_not_replace_previous_output(self):
        for command in ("extract", "export"):
            with (
                self.subTest(command=command),
                tempfile.TemporaryDirectory() as temporary,
            ):
                folder = Path(temporary)
                arguments, inputs = self.prepare(folder, command)
                inputs[1].write_bytes(b"not JSON")
                original = [path.read_bytes() for path in inputs]
                output = folder / "result"
                output.write_bytes(b"last valid result")
                before = set(folder.iterdir())
                status, stdout, stderr = self.invoke([*arguments, "--out", output])
                self.assertEqual(status, 1)
                self.assertEqual(stdout, "")
                self.assertIn("capsulith:", stderr)
                self.assertEqual(output.read_bytes(), b"last valid result")
                self.assertEqual([path.read_bytes() for path in inputs], original)
                self.assertEqual(set(folder.iterdir()), before)

    def test_extract_without_optional_contract_still_publishes(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            _, inputs = self.prepare(folder, "extract")
            output = folder / "capsule.json"
            status, _, stderr = self.invoke(
                ["extract", inputs[0], "--root", "_XXH32", "--out", output]
            )
            self.assertEqual(status, 0, stderr)
            self.assertEqual(json.loads(output.read_bytes())["entry"], 0x440)

    def test_invalid_original_and_symlink_referent_traversal_preserves_output(self):
        for command in ("extract", "export"):
            for component in ("ordinary-file", "missing-directory"):
                for alias in ("direct", "relative-symlink", "absolute-symlink", "chain"):
                    with (
                        self.subTest(command=command, component=component, alias=alias),
                        tempfile.TemporaryDirectory() as temporary,
                    ):
                        folder = Path(temporary)
                        arguments, inputs = self.prepare(folder, command)
                        original = [path.read_bytes() for path in inputs]
                        prefix = folder / component
                        if component == "ordinary-file":
                            prefix.write_bytes(b"not a directory")
                        target = folder / "result"
                        target.write_bytes(b"last valid output")
                        invalid = prefix / ".." / target.name
                        output = invalid
                        if alias != "direct":
                            output = folder / "output-link"
                            referent = invalid if alias == "absolute-symlink" else Path(component) / ".." / target.name
                            if alias == "chain":
                                (folder / "middle-link").symlink_to(referent)
                                referent = Path("middle-link")
                            output.symlink_to(referent)
                        before = set(folder.iterdir())
                        status, stdout, stderr = self.invoke([*arguments, "--out", output])
                        self.assertTrue(target.read_bytes() == b"last valid output")
                        self.assertEqual(status, 1, stderr)
                        self.assertEqual(stdout, "")
                        self.assertIn("capsulith:", stderr)
                        self.assertEqual([path.read_bytes() for path in inputs], original)
                        self.assertEqual(set(folder.iterdir()), before)
                        if alias != "direct":
                            self.assertTrue(output.is_symlink())
                            self.assertEqual(os.readlink(output), str(referent))

    @unittest.skipIf(
        os.name != "posix" or os.geteuid() == 0,
        "Requires an ordinary POSIX user for file permission refusal",
    )
    def test_read_only_existing_outputs_still_refuse_without_changing_bytes(self):
        for command in ("extract", "export"):
            for alias in ("direct", "symlink"):
                with (
                    self.subTest(command=command, alias=alias),
                    tempfile.TemporaryDirectory() as temporary,
                ):
                    folder = Path(temporary)
                    arguments, inputs = self.prepare(folder, command)
                    original = [path.read_bytes() for path in inputs]
                    target = folder / "result"
                    target.write_bytes(b"last valid output")
                    target.chmod(0o444)
                    output = target
                    if alias == "symlink":
                        output = folder / "output-link"
                        output.symlink_to(target.name)
                    before = set(folder.iterdir())
                    status, stdout, stderr = self.invoke([*arguments, "--out", output])
                    self.assertTrue(target.read_bytes() == b"last valid output")
                    self.assertEqual(status, 1, stderr)
                    self.assertEqual(stdout, "")
                    self.assertIn("Permission denied", stderr)
                    self.assertEqual(target.stat().st_mode & 0o777, 0o444)
                    self.assertEqual([path.read_bytes() for path in inputs], original)
                    self.assertEqual(set(folder.iterdir()), before)
                    if alias == "symlink":
                        self.assertTrue(output.is_symlink())

    def test_valid_normalized_paths_and_dangling_symlink_referents_still_publish(self):
        for command in ("extract", "export"):
            for alias in ("normalized", "dangling-symlink"):
                with (
                    self.subTest(command=command, alias=alias),
                    tempfile.TemporaryDirectory() as temporary,
                ):
                    folder = Path(temporary)
                    arguments, inputs = self.prepare(folder, command)
                    original = [path.read_bytes() for path in inputs]
                    (folder / "sub").mkdir()
                    target = folder / "result"
                    output = folder / "sub" / ".." / target.name
                    if alias == "normalized":
                        target.write_bytes(b"last valid output")
                    else:
                        output = folder / "output-link"
                        output.symlink_to(Path("sub") / ".." / target.name)
                    status, _, stderr = self.invoke([*arguments, "--out", output])
                    self.assertEqual(status, 0, stderr)
                    self.assertEqual([path.read_bytes() for path in inputs], original)
                    if command == "extract":
                        self.assertEqual(json.loads(target.read_bytes())["entry"], 0x440)
                    else:
                        with zipfile.ZipFile(target) as archive:
                            self.assertIsNone(archive.testzip())
                            self.assertEqual(json.loads(archive.read("inputs.json")), json.loads(original[1]))
                    if alias == "dangling-symlink":
                        self.assertTrue(output.is_symlink())
                        self.assertEqual(os.readlink(output), str(Path("sub") / ".." / target.name))

    @unittest.skipIf(os.name != "posix", "Requires a POSIX FIFO")
    def test_fifo_output_is_refused_without_a_blocking_write_open(self):
        for command in ("extract", "export"):
            with (
                self.subTest(command=command),
                tempfile.TemporaryDirectory() as temporary,
            ):
                folder = Path(temporary)
                arguments, inputs = self.prepare(folder, command)
                original = [path.read_bytes() for path in inputs]
                output = folder / "fifo"
                os.mkfifo(output)
                result = subprocess.run(
                    [sys.executable, "-m", "capsulith.cli", *map(str, [*arguments, "--out", output])],
                    cwd=ROOT, capture_output=True, text=True, timeout=10,
                )
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertIn("Output must be a regular file", result.stderr)
                self.assertEqual([path.read_bytes() for path in inputs], original)
                self.assertFalse(list(folder.glob(".capsulith-*.tmp")))


if __name__ == "__main__":
    unittest.main()
