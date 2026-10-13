# SPDX-License-Identifier: GPL-2.0-only
import copy
import hashlib
import json
import unittest
from pathlib import Path

from capsulith.artifact import ArtifactError, parse_artifact
from capsulith.extract import extract_capsule
from capsulith.module import extract_module, module_id

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
ARTIFACT = Path(__file__).resolve().parents[1] / "examples/lz4/liblz4.dylib"


class ModuleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.blob = ARTIFACT.read_bytes()

    def test_actual_lifecycle_union_is_exact_and_deterministic(self):
        module = extract_module(self.blob, ENTRIES)
        self.assertEqual(
            module, extract_module(self.blob, dict(reversed(list(ENTRIES.items()))))
        )
        self.assertEqual(module["schema"], "capsulith.module.v1")
        self.assertEqual(module["modelVersion"], "capsulith.memory.v1")
        self.assertEqual(
            module["artifactSHA256"], hashlib.sha256(self.blob).hexdigest()
        )
        self.assertEqual(module["id"], module_id(module))
        image = parse_artifact(self.blob)
        for chunk in module["chunks"]:
            self.assertEqual(
                bytes.fromhex(chunk["bytes"]),
                image.bytes_at(chunk["address"], len(chunk["bytes"]) // 2),
            )
        self.assertEqual(
            {item["name"] for item in module["imports"]},
            {"_malloc", "_bzero", "_free", "_memcpy", "_memmove", "_memset"},
        )
        self.assertEqual(len(module["extraction"]["functions"]), 26)
        self.assertEqual(module["entries"]["compress"]["entry"], 0x7B00)
        self.assertEqual(module["entries"]["create"]["root"], "_LZ4_createStream")

    def test_default_single_function_import_policy_is_unchanged(self):
        with self.assertRaisesRegex(ArtifactError, "unsupported import"):
            extract_capsule(self.blob, "LZ4_createStream")
        original = json.loads((ARTIFACT.parent / "capsule.json").read_text())
        original.pop("contract")
        self.assertEqual(extract_capsule(self.blob, "LZ4_decompress_safe"), original)

    def test_identity_binds_machine_bytes_import_model_and_caller_contract(self):
        module = extract_module(self.blob, ENTRIES)
        for field, value in [("modelVersion", "other"), ("artifactSHA256", "0" * 64)]:
            changed = copy.deepcopy(module)
            changed[field] = value
            self.assertNotEqual(module_id(changed), module["id"])
        changed = copy.deepcopy(module)
        changed["entries"]["compress"]["args"][-1] = "u32"
        self.assertNotEqual(module_id(changed), module["id"])
        changed = copy.deepcopy(module)
        changed["chunks"][0]["bytes"] = "00" + changed["chunks"][0]["bytes"][2:]
        self.assertNotEqual(module_id(changed), module["id"])
        module["extraction"]["displayNote"] = "not executable semantics"
        self.assertEqual(module_id(module), module["id"])

    def test_bad_contracts_are_rejected_before_extraction(self):
        for entries in [
            None,
            [],
            {},
            {"bad name": ENTRIES["create"]},
            {"x": None},
            {"x": {"root": True, "args": [], "return": "reference"}},
            {"x": {"root": "LZ4_createStream", "args": ["i32"] * 9, "return": "i32"}},
            {"x": {"root": "LZ4_createStream", "args": ["pointer"], "return": "i32"}},
            {"x": {"root": "LZ4_createStream", "args": [], "return": "void"}},
            {"x": {**ENTRIES["create"], "inferABI": True}},
        ]:
            with self.subTest(entries=entries), self.assertRaises(ArtifactError):
                extract_module(self.blob, entries)

    def test_unknown_actual_import_remains_refused(self):
        changed = self.blob.replace(b"_malloc\0", b"_foobar\0")
        with self.assertRaisesRegex(ArtifactError, "unsupported import _foobar"):
            extract_module(changed, ENTRIES)

    def test_runtime_reserved_method_names_are_refused_without_renaming(self):
        for name in ("__proto__", "constructor", "prototype"):
            with self.subTest(name=name), self.assertRaises(ArtifactError):
                extract_module(self.blob, {name: ENTRIES["create"]})
        for name in ("Constructor", "Prototype", "constructor2", "prototype_value"):
            with self.subTest(name=name):
                module = extract_module(self.blob, {name: ENTRIES["create"]})
                self.assertEqual(list(module["entries"]), [name])


if __name__ == "__main__":
    unittest.main()
