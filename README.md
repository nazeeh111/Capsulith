# Capsulith

**Preserve compiled native functions and initialized objects as portable machine code.** Keep their original ARM64 instructions, declare the calling contracts, and run selected methods from Node or a browser without the original application. Version 0.2 adds an owned heap, explicit region lifetimes and checkpoints that resume in a fresh worker.

A legacy decoder, checksum or isolated binary routine can become a small reusable API. Capsulith shows which bytes and dependencies travel with it, where execution reads and writes, and why a feature cannot be extracted when it requires unsupported state.

![Original LZ4 methods, restored dictionary access and exact native comparison in the object Studio](docs/objects-studio.png)

## Try it

Try the [keyless browser object demo](https://nazeeh111.github.io/Capsulith/) and press **Run lifecycle**. It executes the actual extracted instructions locally; it does not call a server to generate results.

Download the Python wheel from the [release](https://github.com/nazeeh111/Capsulith/releases/latest), then:

```sh
python3 -m pip install capsulith-0.2.0-py3-none-any.whl
capsulith studio
```

Open http://127.0.0.1:6359. The function Studio retains the LZ4 decoder and xxHash specimens. Open **Object studio**, choose **Open original LZ4 example**, then **Run lifecycle** to create, compress, save a dictionary, checkpoint, restore, continue and free an actual compiled stream. No API key or paid service is needed. Python3.10+ and Capstone are needed for extraction; the browser executes through the included WebAssembly emulator. Node20+ is needed only for CLI or exported Node calls.

The Studio accepts an ARM64 Mach-O dylib, inventories its functions, extracts a selected root, and lets you edit buffers, register arguments, scalar inputs and return type. The dependency view connects helpers/imports to actual call sites and original instructions. Execution events link to the named memory region and original code. Stopped executions show partial evidence without a successful-result claim.

**Export portable capsule** downloads the current bytes, contract and inputs, Node/browser runners, pinned backend, full backend source/build scripts and licenses. Unzip and run `node run.cjs`, or serve that folder over HTTP and open its independent browser runner. Python, Capstone and the original binary are unnecessary for those calls. The exported API accepts different inputs, supports cancellation and enforces the declared limits.

## Keep an initialized native object

The object Studio imports extracted module JSON or reads your owned ARM64 Mach-O artifact with explicitly declared named methods. Inspect the actual roots, chunks and dependencies; allocate named caller buffers from hex or a local file; choose a method and supply typed region references or integers. The memory map shows real owned regions and initialization, with opaque raw bytes rather than guessed fields. Returns, access ranges, counters and bounded events come from original instructions.

Save a checkpoint before an operation you may need to undo. Restoring a matching module preserves guest addresses and region IDs but creates a fresh instance identity; rebind references by region ID. Editing inputs revokes stale evidence, and a fault or cancellation requires a prior checkpoint or a new instance. Native free and caller-buffer release are separate explicit lifecycle operations. The runtime never guesses whether native pointers still refer to a buffer.

```sh
capsulith module examples/lz4/liblz4.dylib \
  --methods examples/native-objects/methods.json --out stream.module.json
node runtime/object-cli.cjs examples/native-objects/start.json \
  --module stream.module.json --checkpoint-out first.checkpoint.json
# The first Node process has ended. This command opens a fresh worker.
node runtime/object-cli.cjs examples/native-objects/continue.json \
  --module stream.module.json --checkpoint first.checkpoint.json
capsulith export-module stream.module.json \
  --checkpoint first.checkpoint.json --out stream-object.zip
```

Choose new output names; module, checkpoint and object export commands refuse to overwrite existing files. The supplied operation programs are specific to the documented LZ4 lifecycle. Generic modules need their own caller-declared methods and operation programs.

An object export contains the original instruction module, optional retained checkpoint bytes, independent Node/browser runners, the object Studio, runtime and corresponding backend source/build scripts, licenses, and a file manifest with bytes, SHA256 and permissions. Serve the folder and open `index.html` to restore the bundled checkpoint without API endpoints, or run `node run.cjs your-operations.json --checkpoint checkpoint.json`. Original binaries, Python packages and compilers are unnecessary for execution. A checkpoint includes retained caller bytes; inspect them before sharing. See [the object API and operation format](runtime/OBJECTS.md) and [the native example](examples/native-objects/README.md).

## Use your own artifact

```sh
capsulith inspect legacy.dylib
capsulith extract legacy.dylib --root _decode \
  --contract decode-contract.json --out decode.capsule.json
capsulith run decode.capsule.json --inputs input.json
capsulith export decode.capsule.json --inputs input.json --out decoder.zip
```

Root selection also accepts a verified function-start address, such as `--root 0x440`. An exported symbol is not a prototype. You supply the actual calling contract; Capsulith does not infer an ABI (the rules that put arguments and return values into registers). The [runtime guide](runtime/README.md) defines buffers, 32/64-bit integers, memory imports and limits. `examples/xxhash/contract.json` is a complete three-argument example.

## What works today

- Ordinary little-endian ARM64 Mach-O64 **dylibs with zero preferred image base**, symbol tables and `LC_FUNCTION_STARTS`. Private helper names may be stripped; function boundaries must remain.
- Exact original instructions, direct branch/call and reachable fallthrough closure, conservative readonly `__const`/`__cstring` retention, explicit bounded `memmove`, `memcpy` and `memset` imports.
- Up to eight integer-register arguments, named read/write/readwrite buffers and signed/unsigned32/64-bit returns. Every logical fetch/read/write is checked, including page padding and import accesses.
- Named method modules additionally support explicit `malloc`, `bzero` and `free` memory models, initialized owned heap bytes and code-bound checkpoints at method boundaries. No heap layout or pointer rewriting is inferred.
- Dedicated workers, host wall-time termination, instruction quotas, bounded traces and cancellation. Uploaded binaries are parsed as bytes and never loaded natively by the product.

Indirect control flow, writable static state, relocated static pointers, unsupported imports, traps, other architectures and other artifact families receive explicit diagnostics. Static address candidates are basic-block syntactic evidence; actual traces establish observed accesses. This first scope does not recover source, infer arbitrary prototypes, clone whole applications or establish emulator security isolation. Artifact hashes record provenance and do not authenticate capsules. Extract and redistribute only artifacts you have rights to use.

## Evidence

The tests exercise real complete library artifacts rather than handwritten algorithm substitutes:

| Specimen | Original code | Independent comparison |
| --- | ---: | --- |
| LZ4 v1.10.0 initialized stream | 12,548 code bytes, 26 functions | Original create/compress/save/free; exact continued outputs across fresh processes; dictionary read evidence; native independent decoding |
| LZ4 v1.10.0 decompressor | 2,456 bytes, three functions | 128 full-native controls, malformed blocks, short output, original static data, declared memmove, stripped helper names |
| xxHash v0.8.3 XXH32, O2 | 308 bytes | 550 distinct input/seed combinations in production Wasm |
| xxHash v0.8.3 XXH32, separately compiled O1 | 284 bytes | Same 550 combinations, different original instructions |

The initialized stream compresses the first 65,536-byte packet to 8,459 bytes and the distinct 32,768-byte packet to 6,795 after restore, versus 8,355 in a fresh stream. Retained input and compiled `saveDict` paths both match the independent native oracle exactly. The browser Studio lifecycle also computed 8,459/6,795 bytes, read 8,205 bytes from retained history and retired the native heap through `freeStream`. These are finite functional comparisons, not a throughput benchmark.

xxHash native controls additionally cover four actual pointer alignments, totaling4,400 native calls. Production pointers are currently aligned. Source licenses, literal oracle inputs/results, artifact hashes and compiler commands are retained in `examples/`. These finite controls support the declared scope; they are not universal equivalence or performance proofs.

Run the release gates from a source checkout:

```sh
python3 -m pip install -e .
python3 -m unittest discover -s tests
node --test tests/*.test.cjs tests/*.test.mjs
node examples/xxhash/check-node.cjs
```

On Apple Silicon, `python3 examples/xxhash/build-native-oracle.py /tmp/new-xxhash-proof` rebuilds both full native controls into a fresh directory and compares them with the retained oracle. The object oracle can be reproduced with `python3 examples/native-objects/build-native-oracle.py /tmp/new-object-proof`, using the pinned known-source LZ4 fixture on Apple Silicon. Native loading is confined to these controlled fixture generators; product extraction parses bytes and execution uses Wasm.

## Architecture and prior work

The Python parser and Capstone disassembly build an inspectable dependency capsule. The JavaScript runtime executes those bytes through [Unicorn.js](https://github.com/AlexAltea/unicorn.js) and [Unicorn](https://github.com/unicorn-engine/unicorn), established CPU-emulation projects. Browser execution of native instructions is their capability. [angr callable](https://docs.angr.io/en/latest/api/angr.callable.html), [Qiling](https://docs.qiling.io/) and [rev.ng](https://docs.rev.ng/) also provide established binary execution, analysis or lifting mechanisms.

Capsulith combines extraction, declared contracts, accessible execution evidence and independently reusable exports, now including explicit initialized object ownership and detached checkpoint continuation. It does not claim to invent emulation, binary analysis or function isolation. LZ4 and xxHash are public, verifiable specimens; their existing source can also be compiled directly to Wasm. The capsule workflow is intended for supported compiled artifacts whose isolated feature you want to retain.

GPL-2.0-only. See [third-party provenance and notices](THIRD_PARTY_NOTICES.md). The published emulator bundle is unchanged and the pinned upstream source/build scripts accompany it; a byte-identical local rebuild of that bundle is not established. Development was assisted by Codex. Bugs and supported-ABI contributions are welcome through [CONTRIBUTING.md](CONTRIBUTING.md).
