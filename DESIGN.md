# Capsulith first delivery

The product moves a compiled native feature into a portable callable capsule. It preserves original ARM64 instructions rather than translating a guessed algorithm or recovering source. The first scope is zero preferred base little-endian ARM64 Mach-O dylibs with function-start metadata, direct control flow, static PC-relative readonly data, and explicitly declared integer/buffer contracts. Unsupported dependencies must be diagnosed, never silently simulated.

## Components and ownership

- Python package `capsulith`: bounded binary parser, exported-function inventory, extraction by symbol or verified function-start address, transitive helpers/imports, conservative readonly sections, disassembly/dependency provenance, validation and CLI. Capstone is the only Python runtime dependency. Uploaded artifacts are never loaded natively.
- JavaScript runtime: validated capsule schema and contract, exact bytes executed through pinned GPLv2 Unicorn.js AArch64 Wasm in a separate worker. Logical memory permissions, declared bounded memmove/memcpy/memset imports, instruction and memory limits, bounded instruction/read/write trace. Host wall timer terminates the worker. No OS, files, network, allocation or arbitrary import hooks.
- Studio: local Python loopback server, actual artifact upload and inventory, function selection/extraction, editable contract/input buffers/scalars, run/cancel, dependency view, execution/memory evidence, portable export. Browser runs capsules in workers. Accessible responsive visual design with empty/error/reset states.
- Portable export: capsule plus original runtime/backend/license files, callable Node API and browser runner. Must execute in a directory without the original binary/source/Python/Capstone. Artifact digest is provenance, not an authenticity signature.

## Contract

Capsule schema version1: architecture `arm64`, artifactSHA256, entry, chunks [{kind:code|readonly,address,bytes,name}], imports [{address,name}], extraction metadata and optional contract. Address space and limits are bounded before execution. Arguments at most eight integer-register values, declared as a buffer pointer, its actual length, its capacity, or named i32/u32/i64/u64 scalar. Return is i32/u32/i64/u64. Buffers have unique names/access read|write|readwrite/capacity and user bytes no larger than capacity. 64-bit scalar/result strings avoid JS rounding. Runtime returns actual result, output buffers and bounded trace/statistics. Contract is caller supplied, not inferred from symbols.

## Acceptance evidence

Use real LZ4 decompression plus a materially different XXH32 routine, independently native controls, withheld separately compiled artifact, stripped private helper names, imported memory routine, malformed input/short output and execution budget cases. Extraction must reject indirect control flow, unsupported import, writable globals/relocations and malformed/truncated metadata. Runtime must reject structural tamper/overlap, inaccessible memory, excess arguments/scalars, count exhaustion, host timeout and trace overflow with bounded diagnostics. Fresh portable/package installs must run exact published bytes. Review consequential parser/execution paths independently before release.

Credit established emulation/extraction/lifting projects. Original code and combined backend distribution use GPL-2.0-only, preserving all upstream notices and exact corresponding source/build provenance. LZ4/xxHash fixtures preserve their BSD licenses. No claims of universal binary support, ABI inference, source reconstruction, emulator security isolation, invented emulation or measured 10x superiority.
