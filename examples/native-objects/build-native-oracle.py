# SPDX-License-Identifier: GPL-2.0-only
"""Controlled ordinary LZ4 calls on the existing owned, licensed fixture only."""

import ctypes
import gc
import hashlib
import json
import platform
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / "examples/lz4/liblz4.dylib"
EXPECTED_SHA = "a0f6e2fce554ce1c4e1cdd2006049fddbeaf268e4262ea68c37e046f910adcbd"
sys.path.insert(0, str(ROOT))
from capsulith.module import extract_module

ENTRIES = {
    "create": {"root": "LZ4_createStream", "args": [], "return": "reference"},
    "compress": {
        "root": "LZ4_compress_fast_continue",
        "args": ["reference", "reference", "reference", "i32", "i32", "i32"],
        "return": "i32",
    },
    "save": {
        "root": "LZ4_saveDict",
        "args": ["reference", "reference", "i32"],
        "return": "i32",
    },
    "free": {"root": "LZ4_freeStream", "args": ["reference"], "return": "i32"},
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: build-native-oracle.py NEW_OUTPUT_DIRECTORY")
    out = Path(sys.argv[1]).resolve()
    out.mkdir(parents=True, exist_ok=False)
    original = ARTIFACT.read_bytes()
    assert digest(original) == EXPECTED_SHA
    assert platform.machine() == "arm64", "known native fixture requires this host ABI"
    library = ctypes.CDLL(str(ARTIFACT))
    pointer, integer = ctypes.c_void_p, ctypes.c_int
    signatures = {
        "LZ4_createStream": (pointer, []),
        "LZ4_freeStream": (integer, [pointer]),
        "LZ4_compressBound": (integer, [integer]),
        "LZ4_compress_fast_continue": (
            integer,
            [pointer, pointer, pointer, integer, integer, integer],
        ),
        "LZ4_saveDict": (integer, [pointer, pointer, integer]),
        "LZ4_decompress_safe_usingDict": (
            integer,
            [pointer, pointer, integer, integer, pointer, integer],
        ),
    }
    for name, (result, arguments) in signatures.items():
        method = getattr(library, name)
        method.restype, method.argtypes = result, arguments

    generator = random.Random(133713)
    pattern = generator.randbytes(8192)
    first = pattern * 8
    # New packet ordering, with long matches that only prior input supplies.
    second = b"".join(
        pattern[offset:] + pattern[:offset] for offset in (237, 1793, 4091, 6077)
    )
    assert first != second and len(first) == 65536 and len(second) == 32768

    def compress(stream, source, size):
        capacity = library.LZ4_compressBound(size)
        destination = ctypes.create_string_buffer(capacity)
        result = library.LZ4_compress_fast_continue(
            stream, source, destination, size, capacity, 1
        )
        assert 0 < result <= capacity, (
            "ordinary compression failed; no reuse after native error"
        )
        return result, destination.raw[:result]

    def decode(compressed, expected, dictionary=b""):
        source = ctypes.create_string_buffer(compressed, len(compressed))
        output = ctypes.create_string_buffer(len(expected))
        retained = (
            ctypes.create_string_buffer(dictionary, len(dictionary))
            if dictionary
            else None
        )
        result = library.LZ4_decompress_safe_usingDict(
            source, output, len(compressed), len(expected), retained, len(dictionary)
        )
        assert result == len(expected) and output.raw == expected
        return {
            "return": result,
            "decodedSHA256": digest(output.raw),
            "equalOriginal": True,
        }

    def run(saved=False):
        stream = library.LZ4_createStream()
        assert stream
        trace = [{"method": "create", "nonNull": True}]
        freed = False
        try:
            source = ctypes.create_string_buffer(first, len(first))
            result1, output1 = compress(stream, source, len(first))
            trace.append({"method": "compress", "packet": 1, "return": result1})
            dictionary = first
            if saved:
                retained_dictionary = ctypes.create_string_buffer(65536)
                saved_count = library.LZ4_saveDict(stream, retained_dictionary, 65536)
                assert saved_count == 65536
                dictionary = retained_dictionary.raw[:saved_count]
                assert dictionary == first
                del source
                gc.collect()
                # From this point onward, the old input ctypes allocation is absent.
                trace.append(
                    {
                        "method": "save",
                        "return": saved_count,
                        "originalInputReleased": True,
                    }
                )
            fresh_source = ctypes.create_string_buffer(second, len(second))
            result2, output2 = compress(stream, fresh_source, len(second))
            trace.append({"method": "compress", "packet": 2, "return": result2})
            return {
                "first": {
                    "return": result1,
                    "hex": output1.hex(),
                    "sha256": digest(output1),
                    "decode": decode(output1, first),
                },
                "second": {
                    "return": result2,
                    "hex": output2.hex(),
                    "sha256": digest(output2),
                    "decode": decode(output2, second, dictionary),
                },
                "trace": trace,
            }
        finally:
            free_result = library.LZ4_freeStream(stream)
            assert free_result == 0
            trace.append({"method": "free", "return": free_result})
            freed = True
            assert freed

    retained = run()
    saved = run(saved=True)
    independent = run()
    assert retained["first"] == independent["first"]
    assert retained["second"] == independent["second"]
    stream = library.LZ4_createStream()
    assert stream
    try:
        source = ctypes.create_string_buffer(second, len(second))
        result, output = compress(stream, source, len(second))
        fresh = {
            "return": result,
            "hex": output.hex(),
            "sha256": digest(output),
            "decode": decode(output, second),
        }
    finally:
        assert library.LZ4_freeStream(stream) == 0
    assert retained["second"]["hex"] != fresh["hex"]
    assert retained["second"]["return"] < fresh["return"]
    assert ARTIFACT.read_bytes() == original
    module = extract_module(original, ENTRIES)
    (out / "module.json").write_text(json.dumps(module, indent=2) + "\n")
    (out / "packets.json").write_text(
        json.dumps(
            {
                "first": first.hex(),
                "second": second.hex(),
                "acceleration": 1,
                "dictionaryCapacity": 65536,
            },
            indent=2,
        )
        + "\n"
    )
    receipt = {
        "schema": "capsulith.native-object-oracle.v1",
        "artifactSHA256": EXPECTED_SHA,
        "artifactUnchanged": True,
        "moduleID": module["id"],
        "platform": {
            "machine": platform.machine(),
            "python": platform.python_version(),
        },
        "mechanism": "native constructor, explicit retained-input and saved-dictionary lifetimes, continued compression, native independent decode, free",
        "retained": retained,
        "saved": saved,
        "independent": independent,
        "fresh": fresh,
        "inputs": {
            "first": {"bytes": len(first), "sha256": digest(first)},
            "second": {"bytes": len(second), "sha256": digest(second)},
        },
        "savedVsRetainedSecondEqual": saved["second"]["hex"]
        == retained["second"]["hex"],
        "historyChangesOutput": True,
        "limitations": [
            "Controlled original inputs on the existing LZ4 build only",
            "No portable runtime result is claimed by this native oracle",
            "LZ4 compression errors require reset/free; no error input executed",
        ],
    }
    recorded = json.loads((Path(__file__).parent / "native-oracle.json").read_text())
    assert receipt["artifactSHA256"] == recorded["artifactSHA256"]
    assert receipt["moduleID"] == recorded["moduleID"]
    for mode in ("retained", "saved", "independent"):
        for block in ("first", "second"):
            assert receipt[mode][block] == recorded[mode][block], (mode, block)
    assert receipt["fresh"] == recorded["fresh"]
    (out / "native-oracle.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(
        json.dumps(
            {
                "moduleID": module["id"],
                "firstBytes": retained["first"]["return"],
                "retainedSecondBytes": retained["second"]["return"],
                "savedSecondBytes": saved["second"]["return"],
                "freshSecondBytes": fresh["return"],
                "savedVsRetainedEqual": receipt["savedVsRetainedSecondEqual"],
                "artifactUnchanged": True,
            }
        )
    )


if __name__ == "__main__":
    main()
