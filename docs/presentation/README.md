# Pixels across a worker boundary

This is an executed case, recorded 17 November 2026 against source [`45e5ec4`](https://github.com/nazeeh111/Capsulith/tree/45e5ec4a02201e91c52d60b89b911e7b4d92b0c8). The [responsive evidence sheet](journey.html) and [JSON record](journey.json) describe the actual run, not a simulated interface. [Returned PNG](orbit-decoded.png) contains the native decoder's output, exported by the workbench.

## What was observed

| Boundary | Actual result |
| --- | --- |
| Source PNG → native encoder | Browser-decoded 128 × 96 RGBA baseline; 808,237 original ARM64 instructions produced 44,561 QOI bytes |
| QOI → separate native decoder | 556,825 original instructions; all 49,152 RGBA bytes equal the browser baseline; encoder and decoder instance IDs differ |
| Saved JSON → new page | Downloaded the preserved state, closed the original page, opened a new workbench page and selected the saved file |
| Fresh-worker restoration | A different runtime instance read the saved native allocation; its 49,152 pixel bytes have the same SHA-256; original native free completed and restored owned regions were retired |
| Standalone Node processes | Decode/preserve → restore → encode; byte comparisons passed for both returned RGBA and the original QOI fixture |

RGBA SHA-256 before and after reopening:

```text
a0ec505c9f96f8cb5299fcc208e57068aca4e8217691dc2cf0ac45af32698507
```

Encoded QOI SHA-256, also identical to the bundled `orbit.qoi`:

```text
189ddf13f5c1692cb24399c4270de9e61702d53e3d7fe1bdcc91d4ed47fabf8d
```

## Repeat in the real workbench

1. [Open the image workbench](https://nazeeh111.github.io/Capsulith/studio/image.html). Open the repository's [`orbit.png`](../../examples/qoi/orbit.png).
2. Choose **Encode & verify pixels**. Inspect the image, QOI byte preview and execution counters. Use arrow keys on a canvas, or the X/Y fields, to inspect a pixel.
3. Choose **Save preserved JSON**, **Save QOI** and **Save PNG**. These are real local exports.
4. Close the page. Open the workbench again and choose **Reopen preserved image** with the saved JSON.
5. Expand **Native memory & instance IDs**. The restored identity differs, and native free completes. The checkpoint can be opened again.

**Load & run example** starts with QOI, so it exercises original decoding and preservation but has no independent PNG baseline. Use PNG for the complete comparison above.

## Repeat without a server or compiler

Use Node 20+ from a source checkout. These commands use the included original instruction module and Wasm runtime. Choose an empty output directory: the CLI refuses existing outputs.

```sh
mkdir /tmp/capsulith-image-proof
node examples/qoi/run.cjs decode examples/qoi/orbit.qoi \
  --out /tmp/capsulith-image-proof/pixels.rgba \
  --preserve /tmp/capsulith-image-proof/image.json
# The decode process has ended. Restore in a different process/worker.
node examples/qoi/run.cjs restore /tmp/capsulith-image-proof/image.json \
  --out /tmp/capsulith-image-proof/restored.rgba
node examples/qoi/run.cjs encode 128 96 \
  /tmp/capsulith-image-proof/restored.rgba \
  --out /tmp/capsulith-image-proof/roundtrip.qoi
cmp /tmp/capsulith-image-proof/pixels.rgba /tmp/capsulith-image-proof/restored.rgba
cmp examples/qoi/orbit.qoi /tmp/capsulith-image-proof/roundtrip.qoi
```

Both `cmp` commands succeeded in the recorded run. `restore` reported `freed: true`, 49,152 bytes and a distinct instance identity. This Node route begins with QOI and compares restoration and re-encoding, while the browser route additionally checks the browser-decoded PNG baseline.

## Scope and provenance

The compiled encoder/decoder are [Dominic Szablewski's QOI](https://github.com/phoboslab/qoi/tree/ffb2d2cb74a1de60819b21b939f7209aa53e91c1), under its retained MIT license. Capsulith's contribution here is the prepared original ARM64 component, explicit calling/memory contracts, bounded execution, observable pixel comparison and retained allocation lifecycle. [Source, compiler flags, fixture hashes and independent native/FFmpeg controls](../../examples/qoi/README.md), [machine-readable upstream provenance](../../examples/qoi/provenance.json), and [component licenses](../../LICENSE) remain authoritative. CPU execution uses the existing Unicorn/Unicorn.js backend.

This is one prepared known-source native component. It does not establish arbitrary binary recovery, inferred object layouts, whole-application continuation, emulator security isolation or performance. The browser accepts images up to 256 pixels per dimension and 1 MiB; preserved JSON is bounded to 8 MiB. PNG import/export uses browser image APIs, while QOI encode/decode uses original compiled instructions. Pixel equality concerns RGBA, not PNG file bytes. Digests detect mismatch; they do not authenticate checkpoint provenance. Save only caller data you have rights to retain/share.

The evidence image is a composition of the actual exported PNG and measured text, not a product screenshot. Its editable source is [`journey.html`](journey.html). Instruction counts are run-specific functional evidence, not throughput measurements. The existing image codec/recovery suite passed all 13 tests; no new native compiler/oracle rebuild was performed for this documentation change.
