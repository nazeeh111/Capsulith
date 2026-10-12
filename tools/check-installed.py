# SPDX-License-Identifier: GPL-2.0-only
"""Verify wheel assets and calls from a fresh directory outside the checkout."""

from pathlib import Path
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
wheel = next((ROOT / "dist").glob("capsulith-0.1.0-*.whl"))
with tempfile.TemporaryDirectory(prefix="capsulith-installed-") as directory:
    root = Path(directory)
    environment = root / "env"
    dependencies = root / "dependencies"
    dependencies.mkdir()
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "download",
            "--no-cache-dir",
            "--only-binary=:all:",
            "--dest",
            str(dependencies),
            "capstone==5.0.9",
        ],
        check=True,
    )
    subprocess.run([sys.executable, "-m", "venv", str(environment)], check=True)
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    subprocess.run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--no-cache-dir",
            "--no-index",
            "--find-links",
            str(dependencies),
            str(wheel),
        ],
        check=True,
        cwd=root,
    )
    probe = """import capsulith,json;from capsulith.resources import resource_root;from capsulith.server import analyze;from capsulith.export import export_zip;import base64;from pathlib import Path
r=resource_root(); assert 'site-packages' in str(r),r
b=(r/'examples/xxhash/libxxhash-o2.dylib').read_bytes();c=analyze({'action':'extract','artifact':base64.b64encode(b).decode(),'root':'_XXH32'});c['contract']=json.loads((r/'examples/xxhash/contract.json').read_text());i=json.loads((r/'examples/xxhash/input.json').read_text());Path('portable.zip').write_bytes(export_zip(c,i));print(json.dumps({'installedModule':capsulith.__file__,'codeBytes':c['extraction']['codeBytes'],'assetRoot':str(r)}))"""
    subprocess.run([str(python), "-c", probe], cwd=root, check=True)
    portable = root / "portable"
    portable.mkdir()
    with zipfile.ZipFile(root / "portable.zip") as archive:
        archive.extractall(portable)
    result = json.loads(
        subprocess.check_output(
            [shutil.which("node") or "node", "run.cjs"], cwd=portable
        )
    )
    expected = json.loads((ROOT / "examples/xxhash/expected.json").read_text())
    assert result["returnValue"] == expected["returnValue"], result
    assert result["outputs"] == expected["outputs"]
    print(
        json.dumps(
            {
                "portableReturn": result["returnValue"],
                "portableFiles": sum(1 for p in portable.rglob("*") if p.is_file()),
                "originalBinaryPresent": bool(list(portable.rglob("*.dylib"))),
            }
        )
    )
