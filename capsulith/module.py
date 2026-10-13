# SPDX-License-Identifier: GPL-2.0-only
"""Union original native method closures with caller-declared object contracts.

No object layout or ABI is inferred. The six memory-operation models are an
explicit extension to single-function extraction, whose defaults are unchanged.
"""

from __future__ import annotations

import hashlib
import json
import re

from .artifact import MAX_CODE, MAX_READONLY, MAX_SPAN, require
from .extract import OBJECT_IMPORTS, _extract_capsule

SCHEMA = "capsulith.module.v1"
MODEL_VERSION = "capsulith.memory.v1"
TYPES = frozenset(("reference", "i32", "u32", "i64", "u64"))
IDENTITY_FIELDS = (
    "schema",
    "architecture",
    "artifactSHA256",
    "modelVersion",
    "chunks",
    "imports",
    "entries",
)
MAX_METHODS = 32
RESERVED_METHOD_NAMES = frozenset(("__proto__", "constructor", "prototype"))


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def module_id(module: dict) -> str:
    """Hash code, named contracts and model version, excluding display evidence."""
    require(isinstance(module, dict), "module identity requires a document")
    require(
        all(key in module for key in IDENTITY_FIELDS), "module identity fields missing"
    )
    payload = {key: module[key] for key in IDENTITY_FIELDS}
    return hashlib.sha256(_canonical(payload).encode("utf-8")).hexdigest()


def _contracts(entries):
    require(
        isinstance(entries, dict) and 1 <= len(entries) <= MAX_METHODS,
        "entries must declare 1 to 32 named methods",
    )
    for name, contract in entries.items():
        require(
            isinstance(name, str)
            and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", name)
            and name not in RESERVED_METHOD_NAMES,
            "method names must be ASCII identifiers of at most 64 characters; "
            "__proto__, constructor and prototype are reserved by the runtime",
        )
        require(
            isinstance(contract, dict) and set(contract) == {"root", "args", "return"},
            f"method {name} must declare exactly root, args and return",
        )
        root = contract["root"]
        require(
            isinstance(root, (str, int)) and not isinstance(root, bool),
            f"method {name} root must be an original symbol or address",
        )
        args = contract["args"]
        require(
            isinstance(args, list)
            and len(args) <= 8
            and all(isinstance(arg, str) and arg in TYPES for arg in args),
            f"method {name} must declare at most 8 reference or integer arguments",
        )
        require(
            isinstance(contract["return"], str) and contract["return"] in TYPES,
            f"method {name} return must be reference or a supported integer type",
        )
    return sorted(entries.items())


def _union(capsules, field):
    records = {}
    for capsule in capsules:
        for record in capsule["extraction"][field]:
            records[_canonical(record)] = record
    return list(records.values())


def extract_module(blob: bytes, entries: dict) -> dict:
    """Extract the union of bounded direct closures of named native methods.

    entries maps names to {root, args:[types], return:type}. Signatures are
    supplied by the caller, not derived from symbols or machine instructions.
    """
    declared = _contracts(entries)
    capsules = []
    resolved = {}
    chunk_map = {}
    import_map = {}
    for name, contract in declared:
        capsule = _extract_capsule(blob, contract["root"], OBJECT_IMPORTS)
        capsules.append(capsule)
        resolved[name] = {
            "entry": capsule["entry"],
            "root": capsule["extraction"]["root"],
            "args": list(contract["args"]),
            "return": contract["return"],
        }
        for chunk in capsule["chunks"]:
            key = (chunk["kind"], chunk["address"])
            require(
                key not in chunk_map or chunk_map[key] == chunk,
                "conflicting extracted chunks",
            )
            chunk_map[key] = chunk
        for imported in capsule["imports"]:
            address = imported["address"]
            require(
                address not in import_map or import_map[address] == imported,
                "conflicting imported targets",
            )
            import_map[address] = imported
    chunks = sorted(
        chunk_map.values(), key=lambda chunk: (chunk["address"], chunk["kind"])
    )
    code_bytes = sum(
        len(chunk["bytes"]) // 2 for chunk in chunks if chunk["kind"] == "code"
    )
    readonly_bytes = sum(
        len(chunk["bytes"]) // 2 for chunk in chunks if chunk["kind"] == "readonly"
    )
    require(code_bytes <= MAX_CODE, "module union code exceeds 4 MiB")
    require(readonly_bytes <= MAX_READONLY, "module union readonly data exceeds 4 MiB")
    minimum = min(chunk["address"] for chunk in chunks)
    maximum = max(chunk["address"] + len(chunk["bytes"]) // 2 for chunk in chunks)
    require(
        maximum - minimum <= MAX_SPAN and maximum <= MAX_SPAN,
        "module addresses exceed the runtime portable 16 MiB address range",
    )
    module = {
        "schema": SCHEMA,
        "architecture": "arm64",
        "artifactSHA256": capsules[0]["artifactSHA256"],
        "modelVersion": MODEL_VERSION,
        "chunks": chunks,
        "imports": [import_map[address] for address in sorted(import_map)],
        "entries": resolved,
        "extraction": {
            **capsules[0]["extraction"],
            "roots": {name: entry["root"] for name, entry in resolved.items()},
            "functions": sorted(
                _union(capsules, "functions"), key=lambda record: record["address"]
            ),
            "dependencies": sorted(
                _union(capsules, "dependencies"),
                key=lambda record: (record["from"], record["to"], record["kind"]),
            ),
            "instructions": sorted(
                _union(capsules, "instructions"), key=lambda record: record["address"]
            ),
            "staticReferences": sorted(
                _union(capsules, "staticReferences"),
                key=lambda record: (record["instruction"], _canonical(record)),
            ),
            "codeBytes": code_bytes,
            "readonlyBytes": readonly_bytes,
            "importPolicy": "explicit malloc, bzero, free, memcpy, memmove and memset models only; no OS access",
        },
    }
    del module["extraction"]["root"]
    module["id"] = module_id(module)
    return module
