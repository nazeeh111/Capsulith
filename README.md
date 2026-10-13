# Portable native component

Run `node run.cjs operations.json` (Node 20+) or serve this folder with
`python3 -m http.server 8000` and open http://localhost:8000. Python is only an
optional static server. No original binary, compiler or Python package is an
execution dependency. The browser uses a dedicated WebAssembly worker.

The component contains original ARM64 instructions and explicit caller-declared
method contracts. Heap fields remain opaque. Ownership, pointer lifetimes and
the correct ABI are the caller's responsibility. The runtime supports bounded
integer/reference methods and six memory imports, not arbitrary OS calls or
all native objects. Identity digests bind bytes; they do not authenticate origin.

If included, checkpoint.json contains ALL retained caller and heap bytes, with
captured work limits. Inspect those bytes before sharing this folder. Restore
preserves guest addresses but creates a fresh instance ID. Rebind references
by region ID; an old instance reference is invalid in a restored instance.

Edit operations.json to declare allocate/call/reference/read/release operations.
The empty starter does not execute a guessed lifecycle. See runtime/OBJECTS.md
for the operation format and API. Use `--checkpoint checkpoint.json` to resume
and `--checkpoint-out new-checkpoint.json` to save after successful operations.
New output files never overwrite an existing path. Faulted/cancelled instances
cannot produce a successful checkpoint. The complete program has a 60s limit.

GPL-2.0-only runtime, corresponding backend source and build scripts are
included under runtime/vendor/. Preserve all notices and use only artifacts
you may extract and redistribute. See LICENSE and THIRD_PARTY_NOTICES.md.
manifest.json lists exact file bytes, SHA256 and Unix permissions except itself.
