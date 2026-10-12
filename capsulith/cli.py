# SPDX-License-Identifier: GPL-2.0-only
import argparse
import base64
import json
from pathlib import Path
import shutil
import subprocess
import sys
from .server import analyze, serve
from .export import export_zip
from .resources import resource_root


def main():
    parser = argparse.ArgumentParser(
        description="Extract native ARM64 features into portable callable capsules"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    inspect = commands.add_parser(
        "inspect", help="Inventory an ARM64 Mach-O dylib without executing it"
    )
    inspect.add_argument("artifact", type=Path)
    extract = commands.add_parser(
        "extract", help="Extract dependency closure for a declared root"
    )
    extract.add_argument("artifact", type=Path)
    extract.add_argument("--root", required=True)
    extract.add_argument("--contract", type=Path)
    extract.add_argument("--out", required=True, type=Path)
    studio = commands.add_parser(
        "studio", help="Open the local upload/extract/execute studio"
    )
    studio.add_argument("--port", type=int, default=6359)
    run = commands.add_parser(
        "run", help="Execute a capsule through Node and Wasm, never native loading"
    )
    run.add_argument("capsule", type=Path)
    run.add_argument("--inputs", required=True, type=Path)
    run.add_argument("--node", default="node")
    run.add_argument("--trace-limit", type=int, default=0)
    export = commands.add_parser(
        "export", help="Export independent Node/browser runner with backend source"
    )
    export.add_argument("capsule", type=Path)
    export.add_argument("--inputs", required=True, type=Path)
    export.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.command in ("inspect", "extract"):
            if args.artifact.stat().st_size > 32 * 1024 * 1024:
                raise ValueError("Artifact exceeds 32 MiB")
            request = {
                "action": args.command,
                "artifact": base64.b64encode(args.artifact.read_bytes()).decode(),
            }
            if args.command == "extract":
                request["root"] = args.root
            result = analyze(request)
            if args.command == "inspect":
                print(json.dumps(result, indent=2))
            else:
                if args.contract:
                    result["contract"] = json.loads(args.contract.read_text())
                args.out.write_text(json.dumps(result, indent=2) + "\n")
                print(f"Extracted entry 0x{result['entry']:x} into {args.out}")
        elif args.command == "studio":
            if not 0 <= args.port <= 65535:
                raise ValueError("Port is out of range")
            serve(args.port)
        elif args.command == "export":
            data = export_zip(
                json.loads(args.capsule.read_text()),
                json.loads(args.inputs.read_text()),
            )
            args.out.write_bytes(data)
            print(f"Portable export: {args.out} ({len(data)} bytes)")
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
            ).returncode
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"capsulith: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
