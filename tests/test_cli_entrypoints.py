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


class CLIEntrypointTests(unittest.TestCase):
    def test_selected_views_use_actual_port_and_matching_installed_metadata(self):
        root = Path(__file__).resolve().parents[1]
        for view, route, asset in (
            (None, "/", "studio/index.html"),
            ("objects", "/studio/objects.html", "studio/objects.html"),
            ("images", "/studio/image.html", "studio/image.html"),
        ):
            with self.subTest(view=view):
                command = [sys.executable, "-B", "-m", "capsulith.cli", "studio", "--port", "0"]
                if view:
                    command += ["--view", view]
                process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                lines = queue.Queue()
                reader = threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True)
                reader.start()
                try:
                    first = lines.get(timeout=10).strip()
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
                    stdout, stderr = process.communicate(timeout=5)
                    self.assertEqual(process.returncode, 0, stderr)
                    self.assertIn("Capsulith Studio stopped.", stdout)
                    self.assertEqual(stderr, "")
                finally:
                    if process.poll() is None:
                        process.terminate()
                        process.communicate(timeout=5)
                    reader.join(timeout=1)
