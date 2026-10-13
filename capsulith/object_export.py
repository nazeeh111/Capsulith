# SPDX-License-Identifier: GPL-2.0-only
"""Source-bearing, self-contained native component exports.

Packaging verifies document identity. The runtime performs the full contract,
region and resource validation before executing or restoring these documents.
"""

import hashlib
import io
import json
import zipfile

from .module import module_id
from .resources import resource_root

MAX_DOCUMENT = 24 * 1024 * 1024
MAX_CHECKPOINT = 64 * 1024 * 1024
MAX_EXPORT = 96 * 1024 * 1024


def _encoded(value, limit, label):
    encoded = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()
    if len(encoded) > limit:
        raise ValueError(f"{label} exceeds export size limit")
    return encoded


def export_module_zip(module, checkpoint=None):
    if (
        not isinstance(module, dict)
        or module.get("schema") != "capsulith.module.v1"
        or module.get("architecture") != "arm64"
        or module.get("modelVersion") != "capsulith.memory.v1"
        or module.get("id") != module_id(module)
    ):
        raise ValueError("A matching ARM64 native module identity is required")
    module_bytes = _encoded(module, MAX_DOCUMENT, "Module")
    if checkpoint is not None:
        if (
            not isinstance(checkpoint, dict)
            or checkpoint.get("schema") != "capsulith.checkpoint.v1"
            or checkpoint.get("moduleId") != module["id"]
            or checkpoint.get("modelVersion") != module["modelVersion"]
            or not isinstance(checkpoint.get("limits"), dict)
        ):
            raise ValueError("Checkpoint must match this module and capture its limits")
        payload = {k: v for k, v in checkpoint.items() if k != "digest"}
        digest = hashlib.sha256(
            json.dumps(
                payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode()
        ).hexdigest()
        if checkpoint.get("digest") != digest:
            raise ValueError("Checkpoint integrity digest mismatch")
        checkpoint_bytes = _encoded(checkpoint, MAX_CHECKPOINT, "Checkpoint")
    root = resource_root()
    files = {}
    modes = {}

    def add(name, data, mode=0o644):
        if name in files:
            raise ValueError("Duplicate export member")
        files[name] = data if isinstance(data, bytes) else data.encode()
        modes[name] = mode

    add("module.json", module_bytes)
    if checkpoint is not None:
        add("checkpoint.json", checkpoint_bytes)
    add(
        "portable.json",
        _encoded(
            {
                "schema": "capsulith.portable.v1",
                "moduleFile": "module.json",
                "checkpointFile": "checkpoint.json" if checkpoint is not None else None,
            },
            MAX_DOCUMENT,
            "Portable descriptor",
        ),
    )
    add("operations.json", '{"schema":"capsulith.operations.v1","operations":[]}\n')
    add(
        "run.cjs",
        "/* SPDX-License-Identifier: GPL-2.0-only */\nrequire('./runtime/object-cli.cjs').main(process.argv.slice(2), __dirname).catch(e=>{console.error(JSON.stringify({code:e.code||'INPUT',message:e.message}));process.exitCode=1;});\n",
    )
    add(
        "index.html",
        '<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=studio/objects.html"><title>Capsulith native object</title><a href="studio/objects.html">Open native object studio</a></html>\n',
    )
    add(
        "README.md",
        """# Portable native component

Run `node run.cjs operations.json` (Node 20+) or serve this folder with
`python3 -m http.server 8000` and open http://localhost:8000. Python is only an
optional static server. No original binary, compiler or Python package is an
execution dependency. The browser uses a dedicated WebAssembly worker.

The component contains original ARM64 instructions and explicit caller-declared
method contracts. Heap fields remain opaque. Ownership, pointer lifetimes and
the correct ABI are the caller's responsibility. The runtime supports bounded
integer/reference methods and six memory imports, not arbitrary OS calls or
all native objects. Identity digests bind bytes; they do not authenticate origin.

If included, checkpoint.json contains ALL retained caller and heap bytes, with
captured work limits. Inspect those bytes before sharing this folder. Restore
preserves guest addresses but creates a fresh instance ID. Rebind references
by region ID; an old instance reference is invalid in a restored instance.

Edit operations.json to declare allocate/call/reference/read/release operations.
The empty starter does not execute a guessed lifecycle. See runtime/OBJECTS.md
for the operation format and API. Use `--checkpoint checkpoint.json` to resume
and `--checkpoint-out new-checkpoint.json` to save after successful operations.
New output files never overwrite an existing path. Faulted/cancelled instances
cannot produce a successful checkpoint. The complete program has a 60s limit.

GPL-2.0-only runtime, corresponding backend source and build scripts are
included under runtime/vendor/. Preserve all notices and use only artifacts
you may extract and redistribute. See LICENSE and THIRD_PARTY_NOTICES.md.
manifest.json lists exact file bytes, SHA256 and Unix permissions except itself.
""",
    )
    for file in sorted((root / "runtime").rglob("*")):
        if file.is_file() and "__pycache__" not in file.parts:
            add(
                file.relative_to(root).as_posix(),
                file.read_bytes(),
                file.stat().st_mode & 0o777,
            )
    for name in (
        "objects.html",
        "objects.js",
        "objects.css",
        "objects-model.mjs",
        "favicon.svg",
    ):
        data = (root / "studio" / name).read_bytes()
        if name == "objects.html":
            if b"<body>" not in data:
                raise ValueError("Studio portable-mode entry point is missing")
            data = data.replace(b"<body>", b'<body data-portable="true">', 1)
        add("studio/" + name, data)
    for name in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
        add(name, (root / name).read_bytes())
    for specimen in ("lz4", "xxhash"):
        add(
            f"licenses/{specimen}-BSD-2-Clause.txt",
            (root / "examples" / specimen / "LICENSE").read_bytes(),
        )
    if sum(map(len, files.values())) > MAX_EXPORT:
        raise ValueError("Source-bearing export exceeds 96 MiB")
    manifest = {
        "schema": "capsulith.export.v1",
        "moduleId": module["id"],
        "files": [
            {
                "path": name,
                "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
                "mode": modes[name],
            }
            for name, data in sorted(files.items())
        ],
    }
    add("manifest.json", _encoded(manifest, MAX_DOCUMENT, "Manifest"))
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            info = zipfile.ZipInfo(name, (2026, 10, 13, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (0o100000 | modes[name]) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    return output.getvalue()
