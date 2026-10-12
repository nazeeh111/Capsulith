# SPDX-License-Identifier: GPL-2.0-only
"""Bounded extraction subprocess. Never loads the uploaded artifact natively."""

import base64
import json
import sys
from .artifact import inspect_artifact
from .extract import extract_capsule


def main():
    try:
        # POSIX output-file ceiling; never weaken a tighter inherited limit.
        try:
            import resource

            soft, hard = resource.getrlimit(resource.RLIMIT_FSIZE)
            bound = 64 * 1024 * 1024
            ceiling = bound if hard == resource.RLIM_INFINITY else min(bound, hard)
            if soft != resource.RLIM_INFINITY:
                ceiling = min(ceiling, soft)
            resource.setrlimit(resource.RLIMIT_FSIZE, (ceiling, hard))
        except (ImportError, OSError, ValueError):
            pass
        raw = sys.stdin.buffer.read(48 * 1024 * 1024 + 1)
        if len(raw) > 48 * 1024 * 1024:
            raise ValueError("Request exceeds 48 MiB")
        request = json.loads(raw)
        artifact = base64.b64decode(request["artifact"], validate=True)
        if request["action"] == "inspect":
            result = inspect_artifact(artifact)
        elif request["action"] == "extract":
            result = extract_capsule(artifact, request["root"])
        else:
            raise ValueError("Unsupported operation")
        encoded = json.dumps({"ok": True, "result": result}, separators=(",", ":"))
        if len(encoded.encode()) > 64 * 1024 * 1024:
            raise ValueError("Analysis response exceeds 64 MiB")
        print(encoded)
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": str(exc),
                    "code": getattr(exc, "code", "EXTRACTION_ERROR"),
                }
            )
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
