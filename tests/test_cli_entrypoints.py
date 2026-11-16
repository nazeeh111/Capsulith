# SPDX-License-Identifier: GPL-2.0-only
"""Actual CLI entry URLs, ephemeral ports and owned server shutdown."""
import json
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading
import unittest
import urllib.error
import urllib.request

from capsulith import __version__


# Test-private stack collection leaves the actual CLI entry module unchanged.
CHILD_BOOTSTRAP = """
import faulthandler, runpy, signal
if hasattr(signal, 'SIGUSR1'):
    faulthandler.register(signal.SIGUSR1, all_threads=True)
runpy.run_module('capsulith.cli', run_name='__main__', alter_sys=True)
"""


class CLIProcess:
    """Drain both pipes while retaining the bounded startup/owned-child contract."""

    def __init__(self, command):
        self.process = subprocess.Popen(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        self.lines = queue.Queue()
        self.stdout_lines = []
        self.stderr_lines = []
        self.stderr_changed = threading.Event()
        self.readers = [
            threading.Thread(target=self._drain_stdout, daemon=True),
            threading.Thread(target=self._drain_stderr, daemon=True),
        ]
        for reader in self.readers:
            reader.start()

    def _drain_stdout(self):
        for line in self.process.stdout:
            self.stdout_lines.append(line)
            self.lines.put(line)
        self.lines.put(None)

    def _drain_stderr(self):
        for line in self.process.stderr:
            self.stderr_lines.append(line)
            self.stderr_changed.set()

    @property
    def stdout(self):
        return ''.join(self.stdout_lines)

    @property
    def stderr(self):
        return ''.join(self.stderr_lines)

    def diagnostics(self, reason):
        return (f'{reason}; child_exit={self.process.poll()}\n'
                f'stdout:\n{self.stdout[-16384:]}\nstderr:\n{self.stderr[-16384:]}')

    def first_line(self, timeout=10):
        try:
            line = self.lines.get(timeout=timeout)
        except queue.Empty:
            if self.process.poll() is None and hasattr(signal, 'SIGUSR1'):
                self.stderr_changed.clear()
                self.process.send_signal(signal.SIGUSR1)
                # This is failure-only diagnostic collection, not more ready time.
                self.stderr_changed.wait(timeout=1)
            before_cleanup = self.process.poll()
            self.close()
            raise AssertionError(self.diagnostics(
                f'Studio did not announce readiness within {timeout}s; '
                f'pre_cleanup_exit={before_cleanup}'
            )) from None
        if line is None:
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                pass
            self.close()
            raise AssertionError(self.diagnostics('Studio exited before announcing readiness'))
        return line.strip()

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        for reader in self.readers:
            reader.join(timeout=2)
        self.process.stdout.close()
        self.process.stderr.close()


class CLIEntrypointTests(unittest.TestCase):
    def test_selected_views_use_actual_port_and_matching_installed_metadata(self):
        root = Path(__file__).resolve().parents[1]
        for view, route, asset in (
            (None, "/", "studio/index.html"),
            ("objects", "/studio/objects.html", "studio/objects.html"),
            ("images", "/studio/image.html", "studio/image.html"),
        ):
            with self.subTest(view=view):
                command = [sys.executable, "-B", "-c", CHILD_BOOTSTRAP, "studio", "--port", "0"]
                if view:
                    command += ["--view", view]
                child = CLIProcess(command)
                process = child.process
                try:
                    first = child.first_line(timeout=10)
                    self.assertTrue(first.startswith("Capsulith Studio: http://127.0.0.1:"), first)
                    url = first.split(": ", 1)[1]
                    self.assertTrue(url.endswith(route), url)
                    base = url.removesuffix(route)
                    self.assertNotEqual(base.rsplit(":", 1)[1], "0")
                    with urllib.request.urlopen(url, timeout=5) as response:
                        self.assertEqual(response.read(), (root / asset).read_bytes())
                        self.assertIn("Capsulith/" + __version__, response.headers["Server"])
                    with urllib.request.urlopen(base + "/api/meta", timeout=5) as response:
                        meta = json.load(response)
                    self.assertEqual(meta["version"], __version__)
                    self.assertEqual(meta["views"][view or "functions"], route)
                    foreign = urllib.request.Request(base + "/api/meta", headers={"Origin": "https://foreign.example"})
                    with self.assertRaises(urllib.error.HTTPError) as denied:
                        urllib.request.urlopen(foreign, timeout=5)
                    try:
                        self.assertEqual(denied.exception.code, 403)
                    finally:
                        denied.exception.close()
                    process.send_signal(signal.SIGINT)
                    process.wait(timeout=5)
                    child.close()
                    self.assertEqual(process.returncode, 0, child.stderr)
                    self.assertIn("Capsulith Studio stopped.", child.stdout)
                    self.assertEqual(child.stderr, "")
                finally:
                    child.close()
