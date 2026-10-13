# SPDX-License-Identifier: GPL-2.0-only
"""Build the source-bearing native image workbench, never replacing an output."""

import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    output = Path(sys.argv[1])
    files = {}
    for file in sorted((ROOT / "runtime").rglob("*")):
        if file.is_file() and "__pycache__" not in file.parts:
            files[file.relative_to(ROOT).as_posix()] = file.read_bytes()
    for name in (
        "image.html",
        "image.css",
        "image.mjs",
        "image-codec.mjs",
        "image-codec-core.mjs",
        "favicon.svg",
    ):
        files[f"studio/{name}"] = (ROOT / "studio" / name).read_bytes()
    if b"<body>" not in files["studio/image.html"]:
        raise ValueError("Image portable-mode entry point is missing")
    files["studio/image.html"] = files["studio/image.html"].replace(
        b"<body>", b'<body data-image-portable="true">', 1
    )
    for name in (
        "module.json",
        "orbit.qoi",
        "orbit.png",
        "qoi.h",
        "component.c",
        "LICENSE.qoi",
        "methods.json",
        "native-oracle.json",
        "README.md",
        "provenance.json",
        "run.cjs",
    ):
        files[f"examples/qoi/{name}"] = (ROOT / "examples/qoi" / name).read_bytes()
    for specimen in ("lz4", "xxhash"):
        files[f"licenses/{specimen}-BSD-2-Clause.txt"] = (
            ROOT / "examples" / specimen / "LICENSE"
        ).read_bytes()
    for name in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
        files[name] = (ROOT / name).read_bytes()
    files["index.html"] = (
        b'<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=studio/image.html"><title>Capsulith native image workbench</title><a href="studio/image.html">Open image workbench</a></html>\n'
    )
    files["README.md"] = b"""# Portable native image workbench

Serve this whole folder over localhost HTTP or HTTPS, then open index.html.
Example: python3 -m http.server 8000 (Python is only an optional static server).
No original binary, compiler, Python package or account is needed for execution.
Node 20+ can run node examples/qoi/run.cjs decode examples/qoi/orbit.qoi --out NEW.rgba.
See examples/qoi/README.md for the native codec, preserved heap and CLI contracts.

Uploaded images stay in the browser. Share/download is voluntary. Image JSON
contains your actual pixels, native descriptor and captured runtime limits.
Inspect it before sharing. manifest.json records file bytes and SHA256, not trust
or authentication. GPL-2.0-only app/runtime, complete corresponding Unicorn.js
backend source/build scripts, original MIT QOI source and all notices included.
This demonstrates a prepared original-instruction component, not universal
format recovery, obsolete software recovery, or a native-performance claim.
"""
    manifest = {
        "schema": "capsulith.image-export.v1",
        "files": [
            {
                "path": name,
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "mode": 0o644,
            }
            for name, data in sorted(files.items())
        ],
    }
    files["manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    with (
        output.open("xb") as stream,
        zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive,
    ):
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, (2026, 10, 13, 0, 0, 0))
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    print(
        json.dumps(
            {
                "output": str(output),
                "members": len(files),
                "bytes": output.stat().st_size,
                "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
            }
        )
    )


if __name__ == "__main__":
    main()
