# SPDX-License-Identifier: GPL-2.0-only
"""Rebuild known-source QOI and compare controlled images with independent FFmpeg.

Run on ARM64 macOS with Clang/FFmpeg installed. Destination must be new.
This tool never loads user-provided artifacts or decodes user-provided files.
"""

import argparse
import ctypes
import hashlib
import json
import math
import platform
import shutil
import struct
import subprocess
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
SOURCE_SHA = "7de6fca1a285b1c20d38f2723dec8b774eb9f144edb9710800a95feeea09375a"
ARTIFACT_SHA = "9616a6a8ece0b65b8dfc518f71b92d400fb1809c5af58c7dfc2d810d422bfa01"
UPSTREAM = (
    "https://github.com/phoboslab/qoi/tree/ffb2d2cb74a1de60819b21b939f7209aa53e91c1"
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pixels(kind, width, height):
    result = bytearray()
    for y in range(height):
        for x in range(width):
            if kind == "solid":
                color = (0, 0, 0, 255)
            elif kind == "palette":
                color = ((x % 7) * 37 % 256, (y % 5) * 59 % 256, 128, 255)
            elif kind == "transparent":
                color = (
                    (x * 31) % 256,
                    (y * 47) % 256,
                    (x ^ y) * 3 % 256,
                    (0, 1, 127, 255)[x % 4],
                )
            elif kind == "wrap":
                color = (
                    (x * 127 + y) % 256,
                    (x + y * 129) % 256,
                    (x ^ y) * 253 % 256,
                    255,
                )
            elif kind == "orbit":
                u, v = (x - width / 2) / width, (y - height / 2) / height
                wave = math.sin(math.hypot(u, v) * 52 + math.atan2(v, u) * 3)
                color = (
                    int(126 + 110 * math.sin(u * 7 + wave)),
                    int(135 + 95 * math.sin(v * 8 - wave)),
                    int(140 + 110 * math.cos(wave * 2)),
                    255,
                )
            else:
                color = (x * 5 % 256, y * 7 % 256, (x * 3 + y * 2) % 256, 255)
            result.extend(color)
    return bytes(result)


def png(width, height, rgba):
    def chunk(kind, data):
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data))
        )

    rows = b"".join(
        b"\0" + rgba[y * width * 4 : (y + 1) * width * 4] for y in range(height)
    )
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


class Desc(ctypes.Structure):
    _fields_ = [
        ("width", ctypes.c_uint),
        ("height", ctypes.c_uint),
        ("channels", ctypes.c_ubyte),
        ("colorspace", ctypes.c_ubyte),
    ]


def bind(path):
    lib = ctypes.CDLL(str(path))
    lib.qoi_encode.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(Desc),
        ctypes.POINTER(ctypes.c_int),
    ]
    lib.qoi_encode.restype = ctypes.c_void_p
    lib.qoi_decode.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.POINTER(Desc),
        ctypes.c_int,
    ]
    lib.qoi_decode.restype = ctypes.c_void_p
    lib.capsulith_qoi_free.argtypes = [ctypes.c_void_p]
    return lib


def encode(lib, width, height, rgba, channels):
    source = (
        rgba if channels == 4 else bytes(v for i, v in enumerate(rgba) if i % 4 != 3)
    )
    buf, desc, length = (
        ctypes.create_string_buffer(source),
        Desc(width, height, channels, 0),
        ctypes.c_int(),
    )
    pointer = lib.qoi_encode(buf, ctypes.byref(desc), ctypes.byref(length))
    if not pointer:
        raise AssertionError("Controlled native encoder refused image")
    try:
        return ctypes.string_at(pointer, length.value)
    finally:
        lib.capsulith_qoi_free(pointer)


def decode(lib, data):
    buf, desc = ctypes.create_string_buffer(data), Desc()
    pointer = lib.qoi_decode(buf, len(data), ctypes.byref(desc), 4)
    if not pointer:
        raise AssertionError("Controlled native decoder refused image")
    try:
        return (
            desc.width,
            desc.height,
            ctypes.string_at(pointer, desc.width * desc.height * 4),
        )
    finally:
        lib.capsulith_qoi_free(pointer)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path)
    parser.add_argument(
        "--native-only",
        action="store_true",
        help="Explicitly omit the independent FFmpeg control",
    )
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("Known ARM64 macOS native control requires Apple Silicon")
    clang, ffmpeg = shutil.which("clang"), shutil.which("ffmpeg")
    if not clang or (not ffmpeg and not args.native_only):
        raise SystemExit("Clang and FFmpeg must already be installed")
    if (
        sha((HERE / "qoi.h").read_bytes()) != SOURCE_SHA
        or sha((HERE / "libqoi.dylib").read_bytes()) != ARTIFACT_SHA
    ):
        raise SystemExit(
            "Known source/artifact identity changed; refusing native loading"
        )
    target = args.destination.resolve()
    target.mkdir(parents=True, exist_ok=False)
    for name in ("qoi.h", "component.c", "LICENSE.qoi"):
        shutil.copyfile(HERE / name, target / name)
    command = [
        clang,
        "-arch",
        "arm64",
        "-O1",
        "-fno-stack-protector",
        "-dynamiclib",
        "-o",
        "rebuilt.dylib",
        "component.c",
    ]
    subprocess.run(command, cwd=target, check=True, timeout=60)
    original, rebuilt = bind(HERE / "libqoi.dylib"), bind(target / "rebuilt.dylib")
    cases = []
    specifications = [
        ("solid", 17, 9, 4),
        ("palette", 41, 13, 4),
        ("gradient", 31, 19, 3),
        ("wrap", 23, 29, 4),
        ("transparent", 64, 37, 4),
        ("orbit", 128, 96, 4),
        ("maximum", 256, 256, 4),
        ("rgb", 19, 11, 3),
    ]
    for name, width, height, channels in specifications:
        raw = pixels(name, width, height)
        encoded = encode(original, width, height, raw, channels)
        assert encode(rebuilt, width, height, raw, channels) == encoded
        assert decode(original, encoded) == (width, height, raw)
        assert decode(rebuilt, encoded) == (width, height, raw)
        (target / f"{name}.qoi").write_bytes(encoded)
        (target / f"{name}.rgba").write_bytes(raw)
        if not args.native_only:
            ff = subprocess.check_output(
                [
                    ffmpeg,
                    "-v",
                    "error",
                    "-i",
                    str(target / f"{name}.qoi"),
                    "-frames:v",
                    "1",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgba",
                    "pipe:1",
                ],
                timeout=20,
            )
            assert ff == raw, f"FFmpeg pixel mismatch: {name}"
        cases.append(
            {
                "name": name,
                "width": width,
                "height": height,
                "channels": channels,
                "rgbaHex": raw.hex(),
                "qoiHex": encoded.hex(),
                "rgbaSHA256": sha(raw),
                "qoiSHA256": sha(encoded),
                "nativeRebuiltMatches": True,
                "ffmpegDecodedMatches": not args.native_only,
            }
        )
        if name == "orbit":
            (target / "orbit.png").write_bytes(png(width, height, raw))
    receipt = {
        "schema": "capsulith.qoi-oracle.v1",
        "upstream": UPSTREAM,
        "sourceSHA256": SOURCE_SHA,
        "artifactSHA256": ARTIFACT_SHA,
        "rebuiltSHA256": sha((target / "rebuilt.dylib").read_bytes()),
        "compiler": subprocess.check_output(
            [clang, "--version"], text=True
        ).splitlines()[0],
        "command": command,
        "ffmpeg": subprocess.check_output([ffmpeg, "-version"], text=True).splitlines()[
            0
        ]
        if not args.native_only
        else None,
        "cases": cases,
    }
    (target / "native-oracle.json").write_text(json.dumps(receipt, indent=2) + "\n")
    assert sha((HERE / "libqoi.dylib").read_bytes()) == ARTIFACT_SHA
    print(
        json.dumps(
            {
                "cases": len(cases),
                "nativeOriginal": True,
                "nativeRebuild": True,
                "independentFFmpeg": not args.native_only,
                "destination": str(target),
            }
        )
    )


if __name__ == "__main__":
    main()
