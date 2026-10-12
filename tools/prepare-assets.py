# SPDX-License-Identifier: GPL-2.0-only
"""Refresh product specimens from committed binaries, without native loading."""

from pathlib import Path
import base64
import hashlib
import json
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from capsulith import extract_capsule

lz = ROOT / "examples" / "lz4"
contract = json.loads((lz / "contract.json").read_text())
contract["args"][-1] = {"kind": "capacity", "buffer": "destination"}
capsule = extract_capsule((lz / "liblz4.dylib").read_bytes(), "_LZ4_decompress_safe")
capsule["contract"] = contract
(lz / "capsule.json").write_text(json.dumps(capsule, indent=2) + "\n")
receipt = json.loads((lz / "native-oracle.json").read_text())
case = next(
    c
    for c in receipt["cases"]
    if c.get("kind") == "repeat" and c.get("size") == 128 and c.get("capacity") == 128
)
example = json.loads(json.dumps(capsule))
example["contract"]["buffers"][1]["capacity"] = case["capacity"]
examples = [
    {
        "id": "lz4",
        "title": "LZ4 / decode original bytes",
        "description": "A real decoder, two stripped helper functions, static data and a bounded memmove import.",
        "artifactBase64": base64.b64encode((lz / "liblz4.dylib").read_bytes()).decode(),
        "root": "_LZ4_decompress_safe",
        "capsule": example,
        "inputs": {"buffers": {"source": case["compressed"], "destination": ""}},
        "evidence": {
            "expectedReturn": case["return"],
            "expectedOutput": case["expectedOutput"],
            "nativeCases": 128,
        },
    }
]
xx = ROOT / "examples" / "xxhash"
for optimization in ("o2", "o1"):
    c = extract_capsule((xx / f"libxxhash-{optimization}.dylib").read_bytes(), "_XXH32")
    c["contract"] = json.loads((xx / "contract.json").read_text())
    (xx / f"xxh32-{optimization}.capsule.json").write_text(
        json.dumps(c, indent=2) + "\n"
    )
    if optimization == "o2":
        examples.append(
            {
                "id": "xxhash",
                "title": "xxHash / transplant a hash",
                "description": "308 original ARM64 code bytes. No imports. Read bytes and return a precise unsigned checksum.",
                "artifactBase64": base64.b64encode(
                    (xx / "libxxhash-o2.dylib").read_bytes()
                ).decode(),
                "root": "_XXH32",
                "capsule": c,
                "inputs": json.loads((xx / "input.json").read_text()),
                "evidence": json.loads((xx / "expected.json").read_text()),
            }
        )
(ROOT / "examples" / "studio.json").write_text(json.dumps(examples, indent=2) + "\n")
(lz / "manifest.json").write_text(
    json.dumps(
        {
            "upstream": "https://github.com/lz4/lz4/tree/v1.10.0",
            "sourceUse": "Original upstream fixture, public ABI caller-declared. Source not read by extraction.",
            "files": [
                {
                    "path": p.name,
                    "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
                    "bytes": p.stat().st_size,
                }
                for p in sorted(lz.iterdir())
                if p.is_file() and p.name != "manifest.json"
            ],
        },
        indent=2,
    )
    + "\n"
)
print("Refreshed original-byte specimens; no native loading")
