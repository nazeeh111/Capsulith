# Changelog

## 0.2.0

Portable initialized native objects alongside the original function capsules. Extract named method closures with caller-declared contracts; execute original factory, operation and free instructions in a persistent bounded worker. Explicit memory models support malloc, bzero, free, memcpy, memmove and memset. Heap initialization is tracked without guessed field layouts.

Code-bound checkpoints preserve live heap/caller bytes, stable guest addresses, initialization, counters and captured limits. Fresh restore creates a new instance identity and requires reference rebinding; ceilings can only be reduced. Failed or cancelled instances require a prior checkpoint or a new instance.

Adds an object Studio, generic operations runner, Python module extraction and source-bearing portable object exports. The original compiled LZ4 stream example demonstrates retained input or saved dictionary history across fresh workers/processes, exact independent native output comparisons, and native free. The finite example is a mechanism proof, not a benchmark or arbitrary native component claim. Original schema1 execution remains available.

## 0.1.0

First native-feature capsule release: bounded ARM64 Mach-O extraction, metadata-based private helpers, disassembly/dependency evidence, explicit integer/buffer contracts, bounded Node/browser Wasm execution, local Studio and independent portable exports. Includes real LZ4 and two xxHash compiler variants, original source/licenses and independent native controls. Initial supported scope and known limitations are documented in README.md.
