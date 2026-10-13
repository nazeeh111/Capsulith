# Third-party sources and provenance

Capsulith original code and the combined portable runtime are GPL-2.0-only. CPU emulation is supplied by Unicorn and Unicorn.js, not invented by Capsulith.

## Unicorn.js 2.1.4 / AArch64

The unmodified single-architecture bundle `runtime/vendor/unicorn_aarch64.js` comes from the official npm package `@alexaltea/unicorn-js`2.1.4. SHA256: b497aa99d973f0a5eb27fe7e14e8d32f76298bf6cc6008f9035c4a8d8b91cb37. GNU GPL version2 is preserved in `runtime/vendor/LICENSE.unicorn`. Authors and credits are preserved with the corresponding source archive.

`runtime/vendor/unicorn-js-source-2.1.4.tar.gz` includes the full tracked upstream release source, build scripts, and recursively pinned submodule source, without Git metadata. Unicorn.js v2.1.4 commit: fdfcc4fd5e7d4ceeebe6b4d65b19eea4aa655e5d. Unicorn submodule: 8028ec436f2d9376525352dd38ed9ed6b9f6be10. Documentation submodule: db5434ad4e40c6657766aa6a54eafd92af38192e. Upstream build instructions require Python, CMake and Emscripten, then `python3 build.py aarch64`. Those are free build dependencies; running Capsulith uses the included bundle. We have not established a byte-identical rebuild of the published npm bundle and do not claim reproducible backend bytes. Exact archived source/build files and the unmodified published bundle are included together in packages and portable exports.

Primary sources: https://github.com/AlexAltea/unicorn.js/tree/v2.1.4 and https://github.com/unicorn-engine/unicorn/tree/8028ec436f2d9376525352dd38ed9ed6b9f6be10.

## Capstone

Binary disassembly uses the separately installed official Python distribution capstone5.0.9 (bundled core reports5.0.7), BSD license. https://github.com/capstone-engine/capstone. Capstone is a dependency of artifact extraction, not the portable runner. Its distribution retains its license.

## LZ4 and xxHash specimens

Unmodified LZ4 v1.10.0 sources and BSD-2-Clause license are in `examples/lz4/`; complete compiled fixtures and independent native controls accompany them. Unmodified xxHash v0.8.3 sources and BSD-2-Clause license are in `examples/xxhash/`. Their source, compiler, artifact and oracle provenance is retained in each directory. The libraries are real test specimens, not Capsulith algorithms. Extraction operates on artifact bytes and the explicit public ABI contract, without reading those source files.

Portable exports include the complete specimen notices under `licenses/lz4-BSD-2-Clause.txt` and `licenses/xxhash-BSD-2-Clause.txt`, alongside the GPL/backend notices. The package and source repository also retain them in the examples directories.

A user's selected binary and its extracted bytes may have separate licensing terms. Capsule extraction and export do not grant redistribution rights.
