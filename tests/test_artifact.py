# SPDX-License-Identifier: GPL-2.0-only
import hashlib
import struct
import unittest
from pathlib import Path
from capsulith import ArtifactError, inspect_artifact
from capsulith.artifact import parse_artifact


def controlled_image(
    code=bytes.fromhex("c0035fd6"), readonly=b"\x2a\0\0\0", starts=None
):
    """A real minimal Mach-O layout with controlled bytes, not a native loader."""
    base = 0x200
    starts = starts if starts is not None else [base]

    def enc(number):
        b = []
        while True:
            digit = number & 127
            number >>= 7
            b.append(digit | (128 if number else 0))
            if not number:
                return bytes(b)

    data = bytearray(0x500)
    section = lambda name, address, length, flags: struct.pack(
        "<16s16sQQ8I",
        name,
        b"__TEXT",
        address,
        length,
        address,
        2,
        0,
        0,
        flags,
        0,
        0,
        0,
    )
    segment = struct.pack(
        "<II16s4Q4I", 0x19, 232, b"__TEXT", 0, 0x1000, 0, len(data), 5, 5, 2, 0
    )
    segment += section(b"__text", base, len(code), 0x80000400) + section(
        b"__const", 0x240, len(readonly), 0
    )
    symbols = struct.pack("<6I", 2, 24, 0x300, 1, 0x320, 16)
    previous = 0
    table = b""
    for address in starts:
        table += enc(address - previous)
        previous = address
    table += b"\0"
    function_cmd = struct.pack("<4I", 0x26, 16, 0x350, len(table))
    commands = segment + symbols + function_cmd
    data[:32] = struct.pack("<8I", 0xFEEDFACF, 0x100000C, 0, 6, 3, len(commands), 0, 0)
    data[32 : 32 + len(commands)] = commands
    data[base : base + len(code)] = code
    data[0x240 : 0x240 + len(readonly)] = readonly
    data[0x300:0x310] = struct.pack("<IBBHQ", 1, 0xF, 1, 0, base)
    data[0x320:0x330] = b"\0_root\0" + b"\0" * 9
    data[0x350 : 0x350 + len(table)] = table
    return bytes(data)


class ArtifactTests(unittest.TestCase):
    def test_inventory_is_explicitly_unchecked(self):
        blob = controlled_image()
        r = inspect_artifact(blob)
        self.assertEqual(r["artifactSHA256"], hashlib.sha256(blob).hexdigest())
        self.assertEqual(r["functions"][0]["name"], "_root")
        self.assertEqual(r["functions"][0]["supportStatus"], "unchecked")
        self.assertEqual(r["functions"][0]["address"], 0x200)

    def test_real_xxhash_metadata_and_digest(self):
        folder = Path(__file__).resolve().parents[1] / "examples" / "xxhash"
        paths = sorted(folder.glob("*.dylib"))
        self.assertTrue(paths, "real XXH32 fixtures are required")
        for path in paths:
            with self.subTest(path=path.name):
                blob = path.read_bytes()
                r = inspect_artifact(blob)
                self.assertEqual(r["artifactSHA256"], hashlib.sha256(blob).hexdigest())
                self.assertTrue(
                    any(
                        "_XXH32" in f["aliases"] and f["exported"]
                        for f in r["functions"]
                    )
                )

    def test_invalid_header_and_file_bounds(self):
        for blob in [
            b"",
            b"\0" * 32,
            controlled_image()[:400],
            b"\0" * (32 * 1024 * 1024 + 1),
        ]:
            with self.subTest(length=len(blob)), self.assertRaises(ArtifactError):
                inspect_artifact(blob)
        for offset, value in [(4, 0x1000007), (8, 2), (12, 2), (16, 4097), (20, 8)]:
            b = bytearray(controlled_image())
            struct.pack_into("<I", b, offset, value)
            with self.subTest(offset=offset), self.assertRaises(ArtifactError):
                inspect_artifact(b)

    def test_command_section_and_symbol_bounds(self):
        for offset, value in [
            (36, 7),
            (32 + 72 + 48, 0xFFFFFFF0),
            (32 + 232 + 8, 0xFFFFFFF0),
            (0x300, 100),
            (32 + 72 + 64, 1),
        ]:
            b = bytearray(controlled_image())
            struct.pack_into("<I", b, offset, value)
            with self.subTest(offset=offset), self.assertRaises(ArtifactError):
                inspect_artifact(b)
        b = bytearray(controlled_image())
        b[0x320:0x330] = b"A" * 16
        with self.assertRaisesRegex(ArtifactError, "unterminated"):
            inspect_artifact(b)

    def test_function_starts_must_be_exact_and_aligned(self):
        for starts in [[0x201], [0x100], [0x600]]:
            with self.subTest(starts=starts), self.assertRaises(ArtifactError):
                inspect_artifact(controlled_image(starts=starts))
        b = bytearray(controlled_image())
        b[0x350:0x353] = b"\x80\x04\x81"
        with self.assertRaisesRegex(ArtifactError, "truncated|unterminated"):
            inspect_artifact(b)

    def test_overlapping_sections_and_writable_text_rejected(self):
        b = bytearray(controlled_image())
        struct.pack_into("<Q", b, 32 + 72 + 80 + 32, 0x200)
        struct.pack_into("<I", b, 32 + 72 + 80 + 48, 0x200)
        with self.assertRaisesRegex(ArtifactError, "overlapping"):
            inspect_artifact(b)
        b = bytearray(controlled_image())
        struct.pack_into("<II", b, 32 + 56, 7, 7)
        with self.assertRaisesRegex(ArtifactError, "immutable"):
            inspect_artifact(b)

    def test_random_mutations_have_bounded_python_diagnostics(self):
        import random

        rng = random.Random(23091)
        base = controlled_image()
        for _ in range(300):
            b = bytearray(base)
            for _ in range(1 + rng.randrange(4)):
                index = rng.randrange(len(b))
                b[index] = rng.randrange(256)
            try:
                parse_artifact(b)
            except ArtifactError:
                pass
            except (OverflowError, IndexError, struct.error, UnicodeError) as e:
                self.fail(f"unbounded parser exception: {e}")


if __name__ == "__main__":
    unittest.main()
