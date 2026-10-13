# SPDX-License-Identifier: GPL-2.0-only
"""Build the source-bearing, keyless object demo into a fresh directory."""

import hashlib
import io
import json
import stat
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from capsulith.object_export import export_module_zip


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: build-object-demo.py NEW_OUTPUT_DIRECTORY")
    destination = Path(sys.argv[1]).resolve()
    if destination.exists():
        raise SystemExit("Output directory already exists; choose a new destination")
    example_root = ROOT / "examples/native-objects"
    example = json.loads((example_root / "studio.json").read_text())
    files = {}
    modes = {}
    with zipfile.ZipFile(io.BytesIO(export_module_zip(example["module"]))) as archive:
        if archive.testzip() is not None:
            raise ValueError("Export archive failed integrity check")
        for info in archive.infolist():
            name = Path(info.filename)
            mode = info.external_attr >> 16
            if (
                name.is_absolute()
                or ".." in name.parts
                or not stat.S_ISREG(mode)
                or info.filename in files
            ):
                raise ValueError("Export path/type conflict")
            files[info.filename] = archive.read(info)
            modes[info.filename] = stat.S_IMODE(mode)
    descriptor = json.loads(files["portable.json"])
    descriptor["exampleFile"] = "example.json"
    files["portable.json"] = (json.dumps(descriptor, indent=2) + "\n").encode()
    files["example.json"] = (example_root / "studio.json").read_bytes()
    modes["example.json"] = 0o644
    for name in ("start.json", "continue.json"):
        files[name] = (example_root / name).read_bytes()
        modes[name] = 0o644
    files[".nojekyll"] = b""
    modes[".nojekyll"] = 0o644
    files["manifest.json"] = (
        json.dumps(
            {
                "schema": "capsulith.export.v1",
                "moduleId": example["module"]["id"],
                "files": [
                    {
                        "path": name,
                        "bytes": len(data),
                        "sha256": hashlib.sha256(data).hexdigest(),
                        "mode": modes[name],
                    }
                    for name, data in sorted(files.items())
                    if name != "manifest.json"
                ],
            },
            indent=2,
        )
        + "\n"
    ).encode()
    destination.mkdir(parents=True)
    for name, data in files.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as output:
            output.write(data)
        target.chmod(modes[name])
    print(
        json.dumps(
            {
                "directory": str(destination),
                "files": len(files),
                "moduleId": example["module"]["id"],
                "originalBinaryPresent": False,
            }
        )
    )


if __name__ == "__main__":
    main()
