# Capsulith

**Turn a compiled native function into a portable callable capsule.** Keep its original machine instructions, gather its helpers and readonly data, declare the inputs, then call it from Node or a browser without the original application.

A legacy decoder, checksum or isolated binary routine can become a small reusable API. Capsulith shows which bytes and dependencies travel with it, where execution reads and writes, and why a feature cannot be extracted when it requires unsupported state.

![Real LZ4 machine instructions running in Capsulith Studio](docs/studio.png)

## Try it

Download the Python wheel from the [release](https://github.com/nazeeh111/Capsulith/releases/latest), then:

```sh
python3 -m pip install capsulith-0.1.0-py3-none-any.whl
capsulith studio
```

Open http://127.0.0.1:6359. Select the real LZ4 or xxHash specimen, inspect its declared contract, and press **Run**. No API key or paid service is needed. Python3.10+ and Capstone are needed for extraction; the browser executes through the included WebAssembly emulator. Node20+ is needed only for CLI or exported Node calls.

The Studio accepts an ARM64 Mach-O dylib, inventories its functions, extracts a selected root, and lets you edit buffers, register arguments, scalar inputs and return type. The dependency view connects helpers/imports to actual call sites and original instructions. Execution events link to the named memory region and original code. Stopped executions show partial evidence without a successful-result claim.

**Export portable capsule** downloads the current bytes, contract and inputs, Node/browser runners, pinned backend, full backend source/build scripts and licenses. Unzip and run `node run.cjs`, or serve that folder over HTTP and open its independent browser runner. Python, Capstone and the original binary are unnecessary for those calls. The exported API accepts different inputs, supports cancellation and enforces the declared limits.

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
- Dedicated workers, host wall-time termination, instruction quotas, bounded traces and cancellation. Uploaded binaries are parsed as bytes and never loaded natively by the product.

Indirect control flow, writable static state, relocated static pointers, unsupported imports, traps, other architectures and other artifact families receive explicit diagnostics. Static address candidates are basic-block syntactic evidence; actual traces establish observed accesses. This first scope does not recover source, infer arbitrary prototypes, clone whole applications or establish emulator security isolation. Artifact hashes record provenance and do not authenticate capsules. Extract and redistribute only artifacts you have rights to use.

## Evidence

The tests exercise real complete library artifacts rather than handwritten algorithm substitutes:

| Specimen | Original code | Independent comparison |
| --- | ---: | --- |
| LZ4 v1.10.0 decompressor | 2,456 bytes, three functions | 128 full-native controls, malformed blocks, short output, original static data, declared memmove, stripped helper names |
| xxHash v0.8.3 XXH32, O2 | 308 bytes | 550 distinct input/seed combinations in production Wasm |
| xxHash v0.8.3 XXH32, separately compiled O1 | 284 bytes | Same 550 combinations, different original instructions |

xxHash native controls additionally cover four actual pointer alignments, totaling4,400 native calls. Production pointers are currently aligned. Source licenses, literal oracle inputs/results, artifact hashes and compiler commands are retained in `examples/`. These finite controls support the declared scope; they are not universal equivalence or performance proofs.

Run the release gates from a source checkout:

```sh
python3 -m pip install -e .
python3 -m unittest discover -s tests
node --test tests/runtime.test.cjs
node examples/xxhash/check-node.cjs
```

On Apple Silicon, `python3 examples/xxhash/build-native-oracle.py /tmp/new-xxhash-proof` rebuilds both full native controls into a fresh directory and compares them with the retained oracle. Native loading happens only in that known-source fixture generator.

## Architecture and prior work

The Python parser and Capstone disassembly build an inspectable dependency capsule. The JavaScript runtime executes those bytes through [Unicorn.js](https://github.com/AlexAltea/unicorn.js) and [Unicorn](https://github.com/unicorn-engine/unicorn), established CPU-emulation projects. Browser execution of native instructions is their capability. [angr callable](https://docs.angr.io/en/latest/api/angr.callable.html), [Qiling](https://docs.qiling.io/) and [rev.ng](https://docs.rev.ng/) also provide established binary execution, analysis or lifting mechanisms.

Capsulith combines extraction, declared contracts, accessible execution evidence and independently reusable exports. It does not claim to invent emulation, binary analysis or function isolation. LZ4 and xxHash are public, verifiable specimens; their existing source can also be compiled directly to Wasm. The capsule workflow is intended for supported compiled artifacts whose isolated feature you want to retain.

GPL-2.0-only. See [third-party provenance and notices](THIRD_PARTY_NOTICES.md). The published emulator bundle is unchanged and the pinned upstream source/build scripts accompany it; a byte-identical local rebuild of that bundle is not established. Development was assisted by Codex. Bugs and supported-ABI contributions are welcome through [CONTRIBUTING.md](CONTRIBUTING.md).
