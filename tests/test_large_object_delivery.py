# SPDX-License-Identifier: GPL-2.0-only
"""Regression for a valid default-budget snapshot exceeding 48 MiB JSON."""

import io
import json
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

from capsulith.cli import _read_object_json
from capsulith.object_export import export_module_zip
from capsulith.resources import resource_root


class LargeObjectDeliveryTests(unittest.TestCase):
    def test_full_valid_owned_state_exports_and_restores_without_duplicate_state(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node 20+ is required by the release gate")
        root = resource_root()
        module = root / "examples/native-objects/module.json"
        runtime = root / "runtime/objects.cjs"
        with tempfile.TemporaryDirectory(prefix="capsulith-large-state-") as directory:
            output = Path(directory) / "state.json"
            script = """const fs=require('node:fs');const {createModule}=require(process.argv[1]);
(async()=>{const m=JSON.parse(fs.readFileSync(process.argv[2]));const i=await createModule(m);try{
for(let n=0;n<511;n++)await i.call('create',[],{traceLimit:0});
await i.allocateBuffer({name:'caller',bytes:'',access:'readwrite',capacity:8388608});
fs.writeFileSync(process.argv[3],JSON.stringify(await i.checkpoint()),{flag:'wx'});
}finally{await i.close();}})().catch(e=>{console.error(e);process.exitCode=1;});"""
            subprocess.run(
                [node, "-e", script, str(runtime), str(module), str(output)],
                check=True,
                timeout=60,
            )
            self.assertGreater(output.stat().st_size, 48 * 1024 * 1024)
            checkpoint = _read_object_json(output)
            self.assertEqual(checkpoint["calls"], 511)
            self.assertEqual(len(checkpoint["regions"]), 512)
            data = export_module_zip(json.loads(module.read_text()), checkpoint)
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                descriptor = json.loads(archive.read("portable.json"))
                self.assertLess(len(archive.read("portable.json")), 1000)
                self.assertEqual(descriptor["checkpointFile"], "checkpoint.json")
                self.assertNotIn("checkpoint", descriptor)
                self.assertLess(
                    sum(i.file_size for i in archive.infolist()), 96 * 1024 * 1024
                )
                self.assertEqual(
                    json.loads(archive.read("checkpoint.json")), checkpoint
                )
            program = Path(directory) / "empty.json"
            program.write_text('{"schema":"capsulith.operations.v1","operations":[]}\n')
            restored = Path(directory) / "restored.json"
            subprocess.run(
                [
                    node,
                    str(root / "runtime/object-cli.cjs"),
                    str(program),
                    "--module",
                    str(module),
                    "--checkpoint",
                    str(output),
                    "--checkpoint-out",
                    str(restored),
                ],
                check=True,
                timeout=60,
                stdout=subprocess.DEVNULL,
            )
            result = json.loads(restored.read_text())
            self.assertNotEqual(
                result["originInstanceId"], checkpoint["originInstanceId"]
            )
            for field in (
                "regions",
                "calls",
                "allocations",
                "totalInstructions",
                "limits",
                "nextAddress",
                "nextId",
            ):
                self.assertEqual(result[field], checkpoint[field])


if __name__ == "__main__":
    unittest.main()
