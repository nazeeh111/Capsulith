# SPDX-License-Identifier: GPL-2.0-only
import unittest
import struct
from pathlib import Path
from capsulith import ArtifactError, extract_capsule

try:
    from test_artifact import controlled_image
except ImportError:
    from tests.test_artifact import controlled_image


class ExtractionTests(unittest.TestCase):
    def test_exact_machine_bytes_and_declared_not_inferred_abi(self):
        blob = controlled_image()
        c = extract_capsule(blob, "root")
        self.assertEqual(c["entry"], 0x200)
        self.assertEqual(c["chunks"][0]["bytes"], "c0035fd6")
        self.assertEqual(c["extraction"]["abi"], "caller supplied; not inferred")
        self.assertEqual(c["extraction"]["instructions"][0]["mnemonic"], "ret")
        self.assertEqual(c, extract_capsule(blob, 0x200))
        self.assertEqual(c, extract_capsule(blob, "0x200"))

    def test_direct_helper_closure_without_private_names(self):
        # bl 0x208; ret; ret: two verified starts, helper intentionally unnamed.
        blob = controlled_image(
            bytes.fromhex("02000094c0035fd6c0035fd6"), starts=[0x200, 0x208]
        )
        c = extract_capsule(blob, "root")
        self.assertEqual(
            [f["address"] for f in c["extraction"]["functions"]], [0x200, 0x208]
        )
        self.assertEqual(c["extraction"]["functions"][1]["name"], "function@0x208")
        self.assertEqual(c["extraction"]["dependencies"][0]["kind"], "call")
        self.assertEqual(c["extraction"]["codeBytes"], 12)

    def test_indirect_control_unknown_branches_and_invalid_decode_rejected(self):
        for code, diagnosis in [
            ("00001fd6", "unsupported control"),
            ("00003fd6", "unsupported control"),
            ("00005fd6", "unsupported indirect return"),
            ("10000014", "unknown direct target"),
            ("ffffffff", "invalid ARM64"),
            ("010000d4", "unsupported control"),
            ("40e03bd5", "unsupported control"),
            ("00000000", "unsupported control"),
            ("3f2303d5", "unsupported control"),
        ]:
            with (
                self.subTest(code=code),
                self.assertRaisesRegex(ArtifactError, diagnosis),
            ):
                extract_capsule(controlled_image(bytes.fromhex(code)), "root")

    def test_only_verified_root_addresses_accepted(self):
        for root in [None, True, -1, 0x204, "missing", "../artifact", 1.5]:
            with self.subTest(root=root), self.assertRaises(ArtifactError):
                extract_capsule(controlled_image(), root)

    def test_static_readonly_reference_and_unknown_data_rejected(self):
        # adrp x8, 0; add x8,x8,0x240; ldr w0,[x8]; ret
        code = bytes.fromhex("0800009008010991000140b9c0035fd6")
        c = extract_capsule(controlled_image(code), "root")
        self.assertTrue(
            any(
                r.get("section") == "__const"
                for r in c["extraction"]["staticReferences"]
            )
        )
        # add address 0x280 has no declared section.
        bad = bytes.fromhex("0800009008010a91000140b9c0035fd6")
        with self.assertRaisesRegex(ArtifactError, "unsupported static address"):
            extract_capsule(controlled_image(bad), "root")

    def test_readonly_relocations_and_chained_pointers_rejected(self):
        b = bytearray(controlled_image(readonly=b"\x2a" + b"\0" * 7))
        struct.pack_into("<II", b, 32 + 72 + 80 + 56, 0x300, 1)
        with self.assertRaisesRegex(ArtifactError, "unresolved relocations"):
            extract_capsule(b, "root")
        b = bytearray(controlled_image(readonly=b"\x2a" + b"\0" * 7))
        struct.pack_into("<II", b, 16, 4, 288)
        b[304:320] = struct.pack("<4I", 0x80000034, 16, 0x380, 60)
        fixup = struct.pack("<7I", 0, 28, 60, 60, 0, 1, 0)
        fixup += struct.pack("<II", 1, 8)
        fixup += struct.pack("<IHHQIH", 24, 4096, 6, 0, 0, 1) + struct.pack("<H", 0x240)
        b[0x380 : 0x380 + 60] = fixup
        with self.assertRaisesRegex(ArtifactError, "relocated static pointers"):
            extract_capsule(b, "root")

    def test_writable_static_page_rejected(self):
        b = bytearray(controlled_image(bytes.fromhex("080000b0000140b9c0035fd6")))
        segment = struct.pack(
            "<II16s4Q4I", 0x19, 152, b"__DATA", 0x1000, 0x1000, 0x400, 0x100, 3, 3, 1, 0
        )
        segment += struct.pack(
            "<16s16sQQ8I", b"__data", b"__DATA", 0x1000, 4, 0x400, 2, 0, 0, 0, 0, 0, 0
        )
        b[304:456] = segment
        struct.pack_into("<II", b, 16, 4, 424)
        struct.pack_into("<Q", b, 32 + 48, 0x400)
        with self.assertRaisesRegex(ArtifactError, "writable static page"):
            extract_capsule(b, "root")

    def test_actual_import_identity_cannot_be_silently_stubbed(self):
        paths = list(
            (Path(__file__).resolve().parents[1] / "examples" / "lz4").glob("*.dylib")
        )
        self.assertTrue(paths)
        b = paths[0].read_bytes().replace(b"_memmove\0", b"_unknown\0")
        with self.assertRaisesRegex(ArtifactError, "unsupported import _unknown"):
            extract_capsule(b, "LZ4_decompress_safe")

    def test_dynamic_relocations_are_rejected_even_without_stubs(self):
        for offset_index, count_index in [(14, 15), (16, 17)]:
            b = bytearray(controlled_image(readonly=b"\x40\x02" + b"\0" * 6))
            fields = [0] * 18
            fields[offset_index : count_index + 1] = [0x380, 1]
            b[304:384] = struct.pack("<II18I", 0xB, 80, *fields)
            struct.pack_into("<II", b, 16, 4, 352)
            struct.pack_into("<II", b, 0x380, 0x240, 2 | (3 << 25))
            with (
                self.subTest(table=count_index),
                self.assertRaisesRegex(
                    ArtifactError, "dynamic external/local relocation"
                ),
            ):
                extract_capsule(b, "root")

    def test_w_register_writes_invalidate_x_alias_provenance(self):
        for code in [
            "08020010e803002a000140b9c0035fd6",
            "08020010e803002a08210091000140b9c0035fd6",
            "1d020010fd03002aa00340b9c0035fd6",
        ]:
            c = extract_capsule(controlled_image(bytes.fromhex(code)), "root")
            self.assertFalse(
                any(
                    r.get("section") == "__const"
                    for r in c["extraction"]["staticReferences"]
                )
            )
            self.assertIn(
                "runtime access trace is authoritative",
                c["extraction"]["staticReferencePolicy"],
            )

    def test_reachable_boundary_fallthrough_includes_next_function(self):
        for code in ["20008052c0035fd6", "00000034c0035fd6"]:
            c = extract_capsule(
                controlled_image(bytes.fromhex(code), starts=[0x200, 0x204]), "root"
            )
            self.assertEqual(
                [f["address"] for f in c["extraction"]["functions"]], [0x200, 0x204]
            )
            self.assertTrue(
                any(e["kind"] == "fallthrough" for e in c["extraction"]["dependencies"])
            )
        with self.assertRaisesRegex(ArtifactError, "falls through outside"):
            extract_capsule(controlled_image(bytes.fromhex("1f2003d5")), "root")

    def test_dead_padding_after_return_does_not_follow_next_function(self):
        c = extract_capsule(
            controlled_image(
                bytes.fromhex("c0035fd61f2003d5c0035fd6"), starts=[0x200, 0x208]
            ),
            "root",
        )
        self.assertEqual(len(c["extraction"]["functions"]), 1)
        self.assertFalse(
            any(e["kind"] == "fallthrough" for e in c["extraction"]["dependencies"])
        )

    def test_dcps_traps_are_rejected_before_export(self):
        for word in (0xD4A00001, 0xD4A00002, 0xD4A00003):
            with (
                self.subTest(word=word),
                self.assertRaisesRegex(
                    ArtifactError, "unsupported control instruction dcps"
                ),
            ):
                extract_capsule(
                    controlled_image(
                        struct.pack("<I", word) + bytes.fromhex("c0035fd6")
                    ),
                    "root",
                )

    def test_nonzero_preferred_base_has_explicit_extraction_diagnosis(self):
        b = bytearray(controlled_image())
        preferred = 0x10000000
        struct.pack_into("<Q", b, 32 + 24, preferred)
        for section in (32 + 72, 32 + 72 + 80):
            (address,) = struct.unpack_from("<Q", b, section + 32)
            struct.pack_into("<Q", b, section + 32, preferred + address)
        struct.pack_into("<Q", b, 0x300 + 8, preferred + 0x200)
        with self.assertRaisesRegex(ArtifactError, "nonzero preferred image bases"):
            extract_capsule(b, "root")

    def test_real_xxhash_two_optimizations(self):
        paths = sorted(
            (Path(__file__).resolve().parents[1] / "examples" / "xxhash").glob(
                "*.dylib"
            )
        )
        self.assertGreaterEqual(len(paths), 2)
        sizes = []
        for path in paths:
            c = extract_capsule(path.read_bytes(), "XXH32")
            self.assertEqual(c["imports"], [])
            self.assertEqual(
                c["extraction"]["codeBytes"] // 4, len(c["extraction"]["instructions"])
            )
            self.assertGreater(c["extraction"]["codeBytes"], 200)
            sizes.append(c["extraction"]["codeBytes"])
        self.assertEqual(
            len(set(sizes)), 2, "independent optimization controls must differ"
        )

    def test_real_lz4_closure_if_fixture_present(self):
        folder = Path(__file__).resolve().parents[1] / "examples" / "lz4"
        paths = list(folder.glob("*.dylib"))
        self.assertTrue(paths, "real LZ4 fixtures are required")
        for path in paths:
            c = extract_capsule(path.read_bytes(), "LZ4_decompress_safe")
            self.assertGreater(len(c["extraction"]["functions"]), 1)
            self.assertTrue(any(i["name"] == "_memmove" for i in c["imports"]))
            self.assertGreater(c["extraction"]["codeBytes"], 2000)


if __name__ == "__main__":
    unittest.main()
