# Real xxHash instructions

These are full ARM64 Mach-O dylibs compiled from the unmodified official [xxHash v0.8.3](https://github.com/Cyan4973/xxHash/releases/tag/v0.8.3) `xxhash.c` and `xxhash.h`, with the original BSD-2-Clause [license](LICENSE). No algorithm wrapper, recovered source, rewritten hash or altered xxHash implementation is substituted for `XXH32`.

The declared contract is `XXH32(const void *input, size_t length, unsigned int seed) -> unsigned int`. `contract.json` supplies its three integer-register arguments explicitly: readonly input buffer, actual input length, and unsigned 32-bit seed. The return is unsigned 32-bit. The contract is supplied by the caller, not inferred from the symbol.

`libxxhash-o2.dylib` is the O2 control. `libxxhash-o1.dylib` is separately compiled at O1, yielding different original instruction bytes. Neither is loaded natively by Capsulith. The fixture generation script alone loads its own known official-source build to establish the independent native oracle.

`oracle.json` contains 110 literal hexadecimal input vectors and 2,200 native cases, with explicit unsigned seeds and results. It includes empty, zero, patterned and deterministic random inputs, 4/8/16/32-byte and larger boundary lengths, five seeds including `0xffffffff` and `0x80000000`, and actual native pointer residues 0, 1, 3 and 7 modulo16. Each result was compared between both complete native dylibs, totaling 4,400 native calls.

The extracted O2 capsule retains 308 original code bytes; the O1 capsule retains 284. Both have no imports. Conservative readonly retention also includes 512 and 320 bytes respectively. The capsule files include dependency/disassembly provenance and the explicit contract. `manifest.json` records source URLs, source hashes, exact dylib hashes, build commands, compiler and native-oracle hash.

Run the actual production Node worker runtime against all 550 distinct input/seed combinations for each capsule:

```sh
node examples/xxhash/check-node.cjs
```

This check uses the real worker and pinned Unicorn.js Wasm engine. The current declared buffer-pointer argument is aligned; native misalignment cases establish the control's behavior but do not claim the production contract supports arbitrary pointer offsets.

On Apple Silicon macOS with installed clang, independently rebuild both complete source controls and verify all 4,400 calls against the committed oracle, writing into a new directory:

```sh
python3 examples/xxhash/build-native-oracle.py /tmp/capsulith-xxhash-new-proof
```

Linux CI can parse the committed Mach-O fixtures and execute the portable capsules without native loading. The native rebuild requires Apple Silicon macOS. Different compiler/linker versions may change artifact hashes; the rebuild verifies results rather than promising reproducible dylib bytes.

These are finite corpus checks of supported pure XXH32 instructions. They do not establish universal ABI inference, all xxHash APIs, other architectures, side-channel properties, cryptographic security or arbitrary native application support. xxHash is a noncryptographic hash; do not use it for authentication or password hashing.
