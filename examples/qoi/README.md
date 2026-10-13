# Native pixels, preserved

This is a known-source component-preservation example. Dominic Szablewski's original MIT QOI codec is compiled to a prepared ARM64 Mach-O dylib, then extracted as data. Capsulith runs the selected original instructions through its Unicorn.js WebAssembly backend. JavaScript checks the public header and explicit bounds; it never implements QOI encoding or decoding.

Open the [image workbench](https://nazeeh111.github.io/Capsulith/studio/image.html), or after `capsulith studio`, visit `/studio/image.html`. Load Orbit, inspect returned RGBA bytes, preserve the initialized pixel heap, close its original worker and restore it with a fresh identity. The native free adapter calls modeled free through actual compiled instructions, then the descriptor caller region is released. All restored owned regions must be gone before success is reported.

Bring a PNG or QOI image up to 256 pixels per dimension and 1 MiB. PNG uses the browser's decoded RGBA as its explicit comparison baseline. The original native encoder writes QOI bytes; a separate fresh native decoder must reproduce every baseline RGBA byte. QOI-only input has no independent source-pixel comparison, and the interface says so. Pixel inspection reads returned bytes, including alpha. Browser canvas/PNG presentation may normalize invisible color channels or color management; use QOI or preserved JSON for exact codec/state bytes.

## Standalone Node

Node20+, from any working directory, no original dylib/compiler/Python package:

```sh
node examples/qoi/run.cjs decode input.qoi --out NEW-pixels.rgba --preserve NEW-image.json
node examples/qoi/run.cjs restore NEW-image.json --out NEW-restored.rgba
node examples/qoi/run.cjs encode 128 96 NEW-restored.rgba --out NEW-image.qoi
```

RGBA is unpremultiplied four-byte row-major pixel data. Outputs must be distinct new paths. Restoring reads the native descriptor and pixel heap from the matching checkpoint; its limits and consumed counters survive. Image JSON includes your pixels, so inspect it before sharing. Its digest detects accidental changes, not authenticity or permission to publish.

## Reproduce the evidence

Eight original synthetic images cover solid runs, repeated palette, RGB, wrapping deltas, transparent channels, Orbit and the 256×256 bound. The immutable source is [QOI ffb2d2c](https://github.com/phoboslab/qoi/tree/ffb2d2cb74a1de60819b21b939f7209aa53e91c1). Full source/header/license and the known compiled artifact are in this repository. `component.c` defines QOI_IMPLEMENTATION/QOI_NO_STDIO and adds an explicit free adapter, without changing the codec body. Apple Clang ARM64 -O1/-fno-stack-protector prepares this bounded specimen. Default stack-guard imports are unsupported, not silently stripped by extraction.

On ARM64 macOS with Clang and FFmpeg already installed:

```sh
python examples/qoi/build-native-oracle.py /tmp/NEW-qoi-controls
```

The generator verifies source and original artifact hashes before loading this identified native fixture, rebuilds unchanged source separately, compares both CPU outputs and checks encoded files with independent FFmpeg decoding. The committed `native-oracle.json` records actual results; the Wasm runtime tests compare against those literal CPU bytes and derive their own results. `--native-only` explicitly omits FFmpeg for a host without it and reports that control as absent.

```sh
node --test tests/image-codec.test.mjs
```

The native descriptor's declared ABI is two unsigned32 dimensions followed by channel/colorspace bytes in a 12-byte structure. The extracted module has three explicit integer/reference methods. No layout is inferred by the generic runtime. This is one prepared finite component proof, not universal decoder preservation, recovery of dead software, a complete QOI-file validator, performance superiority or security isolation. Original instructions and the reference codec's acceptance behavior are retained within the explicit memory/instruction bounds.

The image ZIP includes the exact module, source-bearing runtime, complete corresponding backend source/build scripts, original QOI source/license, contracts, artwork, Node runner and full-file manifest. It contains no original dylib and needs no execution server. Serve it over localhost HTTP or HTTPS for browser workers. Underlying QOI and Unicorn authors retain their credits; no endorsement is claimed.
