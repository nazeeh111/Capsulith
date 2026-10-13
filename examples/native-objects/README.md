# Original compiled LZ4 stream, continued after restore

This example retains the original LZ4 v1.10.0 create/compress/save/free instructions from the existing known-source ARM64 fixture, `../lz4/liblz4.dylib`. It demonstrates initialized heap ownership and history across fresh workers/processes, with finite exact comparisons against independent native calls. No LZ4 object layout is embedded in the runtime.

`methods.json` supplies the four explicit caller contracts. `module.json` includes 26 functions, 28 chunks, 12,548 code bytes and 71 readonly bytes. Its original artifact SHA256 is `a0f6e2fce554ce1c4e1cdd2006049fddbeaf268e4262ea68c37e046f910adcbd`; module identity is `fa8d9dce776bf483517b28bca9ddd0039740daa888990ee662286b4ae2dfcfec`. LZ4 source, header, compiler provenance and BSD-2-Clause license remain in `../lz4/`.

## Run the detached sequence

From the repository root, Node 20+:

```sh
node runtime/object-cli.cjs examples/native-objects/start.json \
  --module examples/native-objects/module.json \
  --checkpoint-out NEW-first.checkpoint.json
node runtime/object-cli.cjs examples/native-objects/continue.json \
  --module examples/native-objects/module.json \
  --checkpoint NEW-first.checkpoint.json
```

The first program executes the original constructor, which calls modeled malloc/bzero for a 16,416-byte owned stream. It compresses 65,536 input bytes, calls original `saveDict` into a retained 65,536-byte dictionary, and explicitly releases the earlier input before saving the checkpoint. That Node process ends.

The second program opens a fresh worker, rebinds the known stream/output region IDs, compresses a different 32,768-byte packet using retained dictionary history, then executes original `freeStream`. The example region IDs are explicit outputs of this allocation sequence, not inferred object fields. A changed allocation program must use its own observed IDs.

To carry source and initialized state:

```sh
capsulith export-module examples/native-objects/module.json \
  --checkpoint NEW-first.checkpoint.json --out NEW-stream-object.zip
```

Open the portable folder over localhost HTTP to restore the same checkpoint in its independent browser Studio. Run `node run.cjs /path/to/continue.json --checkpoint checkpoint.json` to continue in its independent Node runner. The exported runtime has no original dylib dependency. A portable checkpoint includes retained caller bytes; inspect them before sharing.

## Observed comparisons

The first packet produces 8,459 compressed bytes. The second produces 6,795 with continued history, versus 8,355 in a fresh stream. Both retaining the original input and using compiled `saveDict` match independent native output exactly, and native dictionary-aware decoding recovers the original packets. Restored continuation records 8,205 bytes read from retained history. This is a functional history discriminator, not a speed or compression-quality benchmark.

The browser Studio guided lifecycle computed the same 8,459/6,795 bytes, compared both blocks byte for byte with the supplied oracle, observed dictionary reads and retired the heap through original free instructions. Its comparison appears only after computing results. The supplied oracle is reference data, never a substituted native return.

`packets.json` contains original inputs; `native-oracle.json` contains literal native outputs and decoding controls. `studio.json` combines module, inputs and comparison context for the local demonstration. Tests exercise factory initialization, separate instances, retained input, saved dictionary, fresh restore, free, missing/foreign references, captured ceilings and faults. These controls establish this supported example; they do not prove equivalence for arbitrary components.

On Apple Silicon, reproduce the independent native oracle into a brand-new directory:

```sh
python3 examples/native-objects/build-native-oracle.py /tmp/NEW-lz4-object-oracle
```

The controlled generator checks the pinned artifact hash before ordinary native LZ4 calls, verifies decoded packets and the source artifact's unchanged bytes. Product extraction reads artifacts as data; object execution uses the included Wasm backend. Check [runtime/OBJECTS.md](../../runtime/OBJECTS.md) for caller lifetimes, error recovery and exact limits. GPL-2.0-only runtime and LZ4 BSD-2-Clause notices remain unchanged.
