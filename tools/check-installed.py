# SPDX-License-Identifier: GPL-2.0-only
"""Offline wheel/portable checks from a fresh directory outside the checkout.

Reuse the already installed pinned Capstone dependency; never download or set up
new dependencies. Every ZIP is preflighted before no-clobber extraction. Object
exports are checked against their complete file manifest, then resumed in a
second Node process without the original binary.
"""

import hashlib
import importlib.metadata
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
PROJECT = (
    (ROOT / "pyproject.toml").read_text().split("[project]", 1)[1].split("\n[", 1)[0]
)
VERSION = re.search(r'^version\s*=\s*"([^"]+)"', PROJECT, re.MULTILINE).group(1)
WHEELS = list((ROOT / "dist").glob(f"capsulith-{VERSION}-*.whl"))
if len(WHEELS) != 1:
    raise SystemExit(
        f"Expected exactly one capsulith {VERSION} wheel in dist; found {len(WHEELS)}"
    )
WHEEL = WHEELS[0]
NODE = shutil.which("node")
if not NODE:
    raise SystemExit("Node 20+ must already be available for installed checks")
DEPENDENCY = importlib.metadata.distribution("capstone")
if DEPENDENCY.version != "5.0.9":
    raise SystemExit(
        "Run from an environment with the declared capstone==5.0.9 already installed"
    )


def sha(data):
    return hashlib.sha256(data).hexdigest()


def run(command, cwd, *, output=False, environment=None):
    if output:
        return json.loads(
            subprocess.check_output(command, cwd=cwd, env=environment, timeout=75)
        )
    subprocess.run(command, cwd=cwd, env=environment, check=True, timeout=75)


def extract_new(source, destination, *, manifest=False):
    """Check all paths/types/duplicates/conflicts and CRCs before writing bytes."""
    if destination.exists():
        raise AssertionError("Extraction needs a brand-new destination")
    with zipfile.ZipFile(source) as archive:
        members = archive.infolist()
        seen, folded = set(), set()
        total = 0
        for info in members:
            name = info.filename
            parts = PurePosixPath(name).parts
            assert name and not name.startswith("/") and "\\" not in name
            assert parts and all(p not in (".", "..", "") for p in parts)
            assert PurePosixPath(name).as_posix() == name and ":" not in name
            assert name not in seen and name.casefold() not in folded
            seen.add(name)
            folded.add(name.casefold())
            kind = stat.S_IFMT(info.external_attr >> 16)
            assert kind in (0, stat.S_IFREG), (name, kind)
            assert not info.is_dir() and not info.flag_bits & 1
            mode = (info.external_attr >> 16) & 0o7777
            assert not mode & 0o7000, (name, mode)
            total += info.file_size
            assert total <= 160 * 1024 * 1024
        for name in seen:
            assert not any(
                parent.as_posix() in seen
                for parent in PurePosixPath(name).parents
                if str(parent) != "."
            )
        assert archive.testzip() is None
        records = None
        if manifest:
            document = json.loads(archive.read("manifest.json"))
            assert document["schema"] == "capsulith.export.v1"
            assert document["moduleId"] == json.loads(archive.read("module.json"))["id"]
            records = {entry["path"]: entry for entry in document["files"]}
            assert len(records) == len(document["files"])
            assert set(records) == seen - {"manifest.json"}
            for info in members:
                if info.filename == "manifest.json":
                    continue
                entry = records[info.filename]
                data = archive.read(info)
                assert len(data) == entry["bytes"] and sha(data) == entry["sha256"]
                assert (info.external_attr >> 16) & 0o777 == entry["mode"]
        destination.mkdir()
        for info in members:
            path = destination.joinpath(*PurePosixPath(info.filename).parts)
            path.parent.mkdir(parents=True, exist_ok=True)
            data = archive.read(info)
            with path.open("xb") as stream:
                stream.write(data)
            mode = (info.external_attr >> 16) & 0o777 or 0o644
            path.chmod(mode)
            assert (
                path.is_file() and not path.is_symlink() and path.read_bytes() == data
            )
            if records and info.filename in records:
                entry = records[info.filename]
                assert path.stat().st_size == entry["bytes"]
                assert sha(path.read_bytes()) == entry["sha256"]
                assert stat.S_IMODE(path.stat().st_mode) == entry["mode"]
        return len(members)


PROBE = """
import capsulith,json,base64
from pathlib import Path
from capsulith.resources import resource_root
from capsulith.server import analyze
from capsulith.export import export_zip
from capsulith import extract_module
r=resource_root();assert 'site-packages' in str(r),r
assert capsulith.__version__==__import__('sys').argv[1]
b=(r/'examples/xxhash/libxxhash-o2.dylib').read_bytes()
c=analyze({'action':'extract','artifact':base64.b64encode(b).decode(),'root':'_XXH32'})
c['contract']=json.loads((r/'examples/xxhash/contract.json').read_text())
i=json.loads((r/'examples/xxhash/input.json').read_text())
Path('function.zip').write_bytes(export_zip(c,i))
m=extract_module((r/'examples/lz4/liblz4.dylib').read_bytes(),json.loads((r/'examples/native-objects/methods.json').read_text()))
assert m['id']==json.loads((r/'examples/native-objects/module.json').read_text())['id']
Path('module.json').write_text(json.dumps(m))
for name in ('start','continue','native-oracle'):
    Path(name+'.json').write_bytes((r/'examples/native-objects'/ (name+'.json')).read_bytes())
print(json.dumps({'installedModule':capsulith.__file__,'codeBytes':c['extraction']['codeBytes'],'assetRoot':str(r),'moduleId':m['id']}))
"""
EXPORT_PROBE = """
import json
from pathlib import Path
from capsulith.object_export import export_module_zip
Path('object.zip').write_bytes(export_module_zip(json.loads(Path('module.json').read_text()),json.loads(Path('first.checkpoint.json').read_text())))
"""

with tempfile.TemporaryDirectory(prefix="capsulith-installed-") as directory:
    root = Path(directory).resolve()
    environment = root / "env"
    run([sys.executable, "-m", "venv", str(environment)], root)
    python = environment / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    clean_env = dict(os.environ, PYTHONPATH="", PYTHONNOUSERSITE="1")
    sites = json.loads(
        subprocess.check_output(
            [
                str(python),
                "-c",
                "import site,json;print(json.dumps(site.getsitepackages()))",
            ],
            env=clean_env,
        )
    )
    site_path = next(Path(p) for p in sites if Path(p).is_dir())
    # Copy the existing approved dependency into this fresh environment; no index.
    shutil.copytree(DEPENDENCY.locate_file("capstone"), site_path / "capstone")
    for metadata in Path(DEPENDENCY.locate_file("")).glob("capstone-*.dist-info"):
        shutil.copytree(metadata, site_path / metadata.name)
    run(
        [
            str(python),
            "-m",
            "pip",
            "install",
            "--no-cache-dir",
            "--no-index",
            "--no-deps",
            str(WHEEL),
        ],
        root,
        environment=clean_env,
    )
    installed = run(
        [str(python), "-c", PROBE, VERSION], root, output=True, environment=clean_env
    )
    installed_module = Path(installed["installedModule"]).resolve()
    assert installed_module.is_relative_to(environment.resolve()), {
        "installedModule": str(installed_module),
        "expectedEnvironment": str(environment.resolve()),
    }
    resources = Path(installed["assetRoot"])
    asset_files = 0
    for folder in ("runtime", "studio", "examples"):
        for source in sorted((ROOT / folder).rglob("*")):
            if (
                source.is_file()
                and "__pycache__" not in source.parts
                and source.suffix != ".pyc"
            ):
                target = resources / source.relative_to(ROOT)
                assert (
                    target.is_file() and target.read_bytes() == source.read_bytes()
                ), str(source.relative_to(ROOT))
                asset_files += 1
    for name in ("LICENSE", "THIRD_PARTY_NOTICES.md"):
        assert (resources / name).read_bytes() == (ROOT / name).read_bytes()
    image_runner = resources / "examples/qoi/run.cjs"
    image = run(
        [NODE, str(image_runner), "decode", str(resources / "examples/qoi/orbit.qoi"),
         "--out", "native-image.rgba", "--preserve", "native-image.json"],
        root, output=True,
    )
    restored_image = run(
        [NODE, str(image_runner), "restore", "native-image.json", "--out", "restored-image.rgba"],
        root, output=True,
    )
    image_oracle = json.loads((resources / "examples/qoi/native-oracle.json").read_text())
    orbit = next(case for case in image_oracle["cases"] if case["name"] == "orbit")
    assert sha((root / "native-image.rgba").read_bytes()) == orbit["rgbaSHA256"]
    assert (root / "restored-image.rgba").read_bytes() == (root / "native-image.rgba").read_bytes()
    assert image["instanceId"] != restored_image["instanceId"] and restored_image["freed"]
    function_files = extract_new(root / "function.zip", root / "function")
    function = run([NODE, "run.cjs"], root / "function", output=True)
    expected = json.loads((resources / "examples/xxhash/expected.json").read_text())
    assert (
        function["returnValue"] == expected["returnValue"]
        and function["outputs"] == expected["outputs"]
    )
    assert not list((root / "function").rglob("*.dylib"))
    first = run(
        [
            NODE,
            str(resources / "runtime/object-cli.cjs"),
            "start.json",
            "--module",
            "module.json",
            "--checkpoint-out",
            "first.checkpoint.json",
        ],
        root,
        output=True,
    )
    cp = json.loads((root / "first.checkpoint.json").read_text())
    assert cp["originInstanceId"] == first["instanceId"]
    heap = next(r for r in cp["regions"] if r["kind"] == "heap")
    assert heap["capacity"] == 16416 and heap["initialized"] == "01" * 16416
    oracle = json.loads((root / "native-oracle.json").read_text())
    one = next(
        op["result"] for op in first["operations"] if op.get("method") == "compress"
    )
    assert one["returnValue"] == oracle["saved"]["first"]["return"]
    assert (
        one["outputs"]["destination"][: one["returnValue"] * 2]
        == oracle["saved"]["first"]["hex"]
    )
    run([str(python), "-c", EXPORT_PROBE], root, environment=clean_env)
    portable = root / "portable-object"
    object_files = extract_new(root / "object.zip", portable, manifest=True)
    assert not list(portable.rglob("*.dylib"))
    assert (
        portable / "runtime/vendor/unicorn-js-source-2.1.4.tar.gz"
    ).read_bytes() == (
        resources / "runtime/vendor/unicorn-js-source-2.1.4.tar.gz"
    ).read_bytes()
    assert b'data-portable="true"' in (portable / "studio/objects.html").read_bytes()
    # The first Node process has completely ended before this independent runner.
    resumed = run(
        [
            NODE,
            "run.cjs",
            str(root / "continue.json"),
            "--checkpoint",
            "checkpoint.json",
            "--checkpoint-out",
            "after-free.checkpoint.json",
        ],
        portable,
        output=True,
    )
    assert resumed["instanceId"] != cp["originInstanceId"]
    two = next(
        op["result"] for op in resumed["operations"] if op.get("method") == "compress"
    )
    assert two["returnValue"] == oracle["saved"]["second"]["return"]
    assert two["stats"]["regions"][heap["id"]]["address"] == heap["address"]
    assert (
        two["outputs"]["destination"][: two["returnValue"] * 2]
        == oracle["saved"]["second"]["hex"]
    )
    dictionary = next(r for r in cp["regions"] if r["name"] == "dictionary")
    assert two["stats"]["regions"][dictionary["id"]]["readBytes"] > 0
    freed = next(
        op["result"] for op in resumed["operations"] if op.get("method") == "free"
    )
    assert freed["returnValue"] == 0 and freed["stats"]["frees"] == 1
    after = json.loads((portable / "after-free.checkpoint.json").read_text())
    assert not any(r["kind"] == "heap" for r in after["regions"])
    before_addresses = {r["id"]: r["address"] for r in cp["regions"]}
    assert all(
        r["address"] == before_addresses[r["id"]]
        for r in after["regions"]
        if r["id"] in before_addresses
    )
    print(
        json.dumps(
            {
                "version": VERSION,
                "installedAssetFilesExact": asset_files,
                "functionReturn": function["returnValue"],
                "functionPortableFiles": function_files,
                "moduleId": installed["moduleId"],
                "objectPortableFilesVerified": object_files,
                "firstCompressedBytes": one["returnValue"],
                "restoredCompressedBytes": two["returnValue"],
                "dictionaryReadBytes": two["stats"]["regions"][dictionary["id"]][
                    "readBytes"
                ],
                "freshInstanceId": resumed["instanceId"] != cp["originInstanceId"],
                "heapRegionsAfterNativeFree": 0,
                "originalBinaryPresentInObjectExport": False,
            }
        )
    )
