# SPDX-License-Identifier: GPL-2.0-only
"""Self-contained exported runtime, with corresponding backend source."""

import io
import json
from pathlib import Path
import zipfile
from .resources import resource_root

PORTABLE_HTML = """<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Capsulith portable capsule</title><style>body{font:16px system-ui;background:#f3f2ec;color:#172b27;max-width:1000px;margin:48px auto;padding:24px}h1{font-size:44px;letter-spacing:-2px}textarea,pre{box-sizing:border-box;width:100%;padding:18px;background:#fff;border:1px solid #b8c3bc;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}textarea{height:240px;font:14px monospace}button{font:inherit;padding:12px 20px;background:#183f32;color:white;border:0;border-radius:6px;cursor:pointer}button:disabled{opacity:.5}p{line-height:1.6}#status{min-height:24px}</style><h1>Original instructions.<br>Independent capsule.</h1><p id="origin"></p><p>This folder runs the extracted native instructions through a WebAssembly emulator. The original binary, Python and Capstone are not required. Serve this folder over HTTP to enable workers.</p><label for="inputs">Declared buffer and scalar inputs</label><textarea id="inputs" spellcheck="false"></textarea><p><button id="run">Run capsule</button> <button id="cancel" disabled>Cancel</button></p><p id="status" role="status" aria-live="polite"></p><pre id="result">No execution yet.</pre><details><summary>Capsule and declared contract</summary><pre id="capsule"></pre></details><p>GPL-2.0-only. Original backend source and build scripts are included under runtime/vendor/. The artifact digest records provenance, not authenticity.</p><script type="module">import{runCapsule}from'./runtime/browser.mjs';const $=id=>document.getElementById(id);const capsule=await(await fetch('./capsule.json')).json();$('inputs').value=JSON.stringify(await(await fetch('./inputs.json')).json(),null,2);$('capsule').textContent=JSON.stringify(capsule,null,2);$('origin').textContent=`ARM64 · entry 0x${capsule.entry.toString(16)} · original artifact SHA256 ${capsule.artifactSHA256}`;let controller;$('cancel').onclick=()=>controller?.abort();$('run').onclick=async()=>{controller=new AbortController();$('run').disabled=true;$('cancel').disabled=false;$('status').textContent='Executing in a dedicated worker…';try{const inputs=JSON.parse($('inputs').value);const result=await runCapsule(capsule,inputs,{traceLimit:0,signal:controller.signal});$('result').textContent=JSON.stringify(result,null,2);$('status').textContent='Returned successfully. Trace capture disabled; access and instruction counts retained.';}catch(e){$('result').textContent=JSON.stringify({code:e.code||'INPUT',message:e.message,details:e.details},null,2);$('status').textContent='Stopped without a successful result.';}finally{$('run').disabled=false;$('cancel').disabled=true;controller=null;}};</script></html>"""


def export_zip(capsule, inputs):
    if (
        not isinstance(capsule, dict)
        or capsule.get("schema") != 1
        or capsule.get("architecture") != "arm64"
    ):
        raise ValueError("A schema1 ARM64 capsule is required")
    if not isinstance(inputs, dict):
        raise ValueError("Inputs must be an object")
    encoded = json.dumps(capsule, indent=2).encode()
    if len(encoded) > 24 * 1024 * 1024:
        raise ValueError("Capsule exceeds export size limit")
    root = resource_root()
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("capsule.json", encoded)
        archive.writestr("inputs.json", json.dumps(inputs, indent=2))
        archive.writestr("index.html", PORTABLE_HTML)
        archive.writestr(
            "run.cjs",
            "const fs=require('node:fs'),path=require('node:path'); const {runCapsule}=require('./runtime/index.cjs'); runCapsule(JSON.parse(fs.readFileSync(path.join(__dirname,'capsule.json'))),JSON.parse(fs.readFileSync(path.join(__dirname,process.argv[2]||'inputs.json'))),{traceLimit:0}).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(JSON.stringify({code:e.code,message:e.message}));process.exitCode=1;});\n",
        )
        archive.writestr(
            "README.md",
            "# Portable Capsulith capsule\n\nRun `node run.cjs` (Node20+) or serve this folder with `python3 -m http.server 8000` and open http://localhost:8000. Python is only an optional static server, not an execution dependency. Edit inputs.json or pass a different input filename to run.cjs. Browser inputs are editable. The contract and original bytes are in capsule.json. Execution limits and supported memory imports are documented in runtime/README.md. Trace capture is explicitly off by default in this portable runner; the API accepts a bounded traceLimit. No original binary or Python package is needed.\n\nUse only artifacts you have permission to extract and redistribute. GPL-2.0-only runtime and exact corresponding backend source/build scripts included; see THIRD_PARTY_NOTICES.md.\n",
        )
        for file in sorted((root / "runtime").rglob("*")):
            if file.is_file() and "__pycache__" not in file.parts:
                archive.write(file, file.relative_to(root).as_posix())
        for specimen in ("lz4", "xxhash"):
            archive.write(
                root / "examples" / specimen / "LICENSE",
                f"licenses/{specimen}-BSD-2-Clause.txt",
            )
        for name in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
            archive.write(root / name, name)
    return stream.getvalue()
