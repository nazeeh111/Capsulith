# SPDX-License-Identifier: GPL-2.0-only
import argparse
import base64
import json
import shutil
import subprocess
import sys
from pathlib import Path

from . import __version__
from .export import export_zip
from .outputs import replace_output
from .resources import resource_root
from .server import STUDIO_VIEWS, analyze, serve


def _read_object_json(path):
    with path.open("rb") as source:
        raw = source.read(64 * 1024 * 1024 + 1)
    if len(raw) > 64 * 1024 * 1024:
        raise ValueError("Object JSON exceeds 64 MiB")
    return json.loads(raw)


def _write_new(path, data):
    with path.open("xb") as destination:
        destination.write(data)


def main():
    parser = argparse.ArgumentParser(
        description="Preserve supported ARM64 functions, declared calls and initialized native state.",
        epilog="Start with: capsulith studio --view images\n"
        "Extract and module parse your owned Mach-O bytes; run executes through Node/Wasm.\n"
        "No native host loading. Use COMMAND --help for inputs and output policy.",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--version", action="version", version=f"Capsulith {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser(
        "inspect", help="Inventory an ARM64 Mach-O dylib without executing it"
    )
    inspect.add_argument("artifact", type=Path)
    extract = commands.add_parser(
        "extract", help="Extract dependency closure for a declared root",
        description="Extract a supported root. An unrelated output may be replaced; input aliases are refused."
    )
    extract.add_argument("artifact", type=Path)
    extract.add_argument("--root", required=True, help="Exported symbol or verified function-start address")
    extract.add_argument("--contract", type=Path, help="Caller-declared argument, buffer and return contract JSON")
    extract.add_argument("--out", required=True, type=Path, help="Capsule JSON; replaces unrelated outputs with staged publication")
    module = commands.add_parser(
        "module", help="Extract named native methods with explicit caller contracts",
        description="Extract declared methods into a new module file. Existing outputs are refused."
    )
    module.add_argument("artifact", type=Path)
    module.add_argument("--methods", required=True, type=Path, help="Caller-declared named methods JSON")
    module.add_argument("--out", required=True, type=Path, help="New module JSON path; never overwrites an existing file")
    studio = commands.add_parser(
        "studio", help="Serve the local function, object or image workbench",
        description="Serve bundled workbenches on loopback. Open the printed URL yourself; Ctrl-C stops the server."
    )
    studio.add_argument("--port", type=int, default=6359, help="Loopback port (default: 6359; 0 chooses a free port)")
    studio.add_argument("--view", choices=tuple(STUDIO_VIEWS), default="functions", help="Printed starting view (default: functions); all three remain available")
    run = commands.add_parser(
        "run", help="Execute a capsule through Node and Wasm, never native loading"
    )
    run.add_argument("capsule", type=Path)
    run.add_argument("--inputs", required=True, type=Path)
    run.add_argument("--node", default="node")
    run.add_argument("--trace-limit", type=int, default=0)
    export = commands.add_parser(
        "export", help="Export independent Node/browser runner with backend source",
        description="Export current capsule and inputs. An unrelated output may be replaced; input aliases are refused."
    )
    export.add_argument("capsule", type=Path)
    export.add_argument("--inputs", required=True, type=Path)
    export.add_argument("--out", required=True, type=Path, help="Portable ZIP; replaces unrelated outputs with staged publication")
    export_module = commands.add_parser(
        "export-module", help="Export a portable native object and optional checkpoint",
        description="Export module and optional retained state to a new ZIP. Existing outputs are refused."
    )
    export_module.add_argument("module", type=Path)
    export_module.add_argument("--checkpoint", type=Path, help="Matching checkpoint JSON, which may contain retained caller bytes")
    export_module.add_argument("--out", required=True, type=Path, help="New module JSON path; never overwrites an existing file")
    args = parser.parse_args()
    try:
        if args.command in ("inspect", "extract", "module"):
            if args.artifact.stat().st_size > 32 * 1024 * 1024:
                raise ValueError("Artifact exceeds 32 MiB")
            request = {
                "action": args.command,
                "artifact": base64.b64encode(args.artifact.read_bytes()).decode(),
            }
            if args.command == "extract":
                request["root"] = args.root
            elif args.command == "module":
                request["methods"] = _read_object_json(args.methods)
            result = analyze(request)
            if args.command == "inspect":
                print(json.dumps(result, indent=2))
            elif args.command == "module":
                _write_new(args.out, (json.dumps(result, indent=2) + "\n").encode())
                print(f"Extracted {len(result['entries'])} methods into {args.out}")
            else:
                if args.contract:
                    result["contract"] = json.loads(args.contract.read_text())
                replace_output(
                    args.out,
                    (json.dumps(result, indent=2) + "\n").encode(),
                    inputs=(args.artifact, args.contract),
                )
                print(f"Extracted entry 0x{result['entry']:x} into {args.out}")
        elif args.command == "studio":
            if not 0 <= args.port <= 65535:
                raise ValueError("Port is out of range")
            serve(args.port, args.view)
        elif args.command == "export":
            data = export_zip(
                json.loads(args.capsule.read_text()),
                json.loads(args.inputs.read_text()),
            )
            replace_output(args.out, data, inputs=(args.capsule, args.inputs))
            print(f"Portable export: {args.out} ({len(data)} bytes)")
        elif args.command == "export-module":
            from .object_export import export_module_zip

            data = export_module_zip(
                _read_object_json(args.module),
                _read_object_json(args.checkpoint) if args.checkpoint else None,
            )
            _write_new(args.out, data)
            print(f"Portable object export: {args.out} ({len(data)} bytes)")
        elif args.command == "run":
            node = shutil.which(args.node)
            if not node:
                raise ValueError(
                    "Node20+ is required for CLI execution; use --node or the browser Studio"
                )
            runner = resource_root() / "runtime" / "cli.cjs"
            return subprocess.run(
                [
                    node,
                    str(runner),
                    str(args.capsule.resolve()),
                    str(args.inputs.resolve()),
                    str(args.trace_limit),
                ],
                timeout=65,
                check=False,
            ).returncode
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"capsulith: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
