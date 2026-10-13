# Changelog

## 0.3.0

Adds a native image workbench: prepared original ARM64 QOI encoder/decoder instructions produce the visible pixels and downloadable files. PNG inputs use browser-decoded RGBA as the explicit baseline; QOI inputs run the native decoder. Inspect individual returned pixels, compare an actual encode/decode round trip, preserve the initialized pixel heap, close its worker, and restore/free it in a fresh worker. Image files remain local and exports are voluntary.

Includes a dependency-free Node file runner, source-bearing static workbench ZIP, and eight controlled image cases compared with original native execution, an independent source rebuild and FFmpeg decoding. The original QOI source and MIT license are preserved. This is a prepared component demonstration with images bounded to 256 pixels per dimension, not a new codec, universal legacy recovery or a speed benchmark. Existing function/object APIs and extraction scope are unchanged.

## 0.2.0

Portable initialized native objects alongside the original function capsules. Extract named method closures with caller-declared contracts; execute original factory, operation and free instructions in a persistent bounded worker. Explicit memory models support malloc, bzero, free, memcpy, memmove and memset. Heap initialization is tracked without guessed field layouts.

Code-bound checkpoints preserve live heap/caller bytes, stable guest addresses, initialization, counters and captured limits. Fresh restore creates a new instance identity and requires reference rebinding; ceilings can only be reduced. Failed or cancelled instances require a prior checkpoint or a new instance.

Adds an object Studio, generic operations runner, Python module extraction and source-bearing portable object exports. The original compiled LZ4 stream example demonstrates retained input or saved dictionary history across fresh workers/processes, exact independent native output comparisons, and native free. The finite example is a mechanism proof, not a benchmark or arbitrary native component claim. Original schema1 execution remains available.

## 0.1.0

First native-feature capsule release: bounded ARM64 Mach-O extraction, metadata-based private helpers, disassembly/dependency evidence, explicit integer/buffer contracts, bounded Node/browser Wasm execution, local Studio and independent portable exports. Includes real LZ4 and two xxHash compiler variants, original source/licenses and independent native controls. Initial supported scope and known limitations are documented in README.md.
