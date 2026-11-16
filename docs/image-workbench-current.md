# Current native image workbench capture

Observed 2026-11-16 from the installed 0.3.2.dev0 package, on localhost at 1280 × 1000. The input is the retained original artwork `examples/qoi/orbit.png`, 128 × 96 pixels. The original ARM64 QOI encoder and a fresh decoder returned all 49,152 RGBA bytes exactly equal to the browser-decoded source. This compares pixels, not PNG file bytes.

The separate QOI example was decoded, its native allocation saved as JSON, then reopened in a new tab and fresh worker. The runtime read the retained pixels and executed the original native free. The same pixel payload matched an installed Node run byte for byte. The LZ4 function and initialized-object examples also ran in this browser; the exported function returned128 in an independent Node process. These are finite fixture checks, not general emulator correctness or security isolation evidence.

The screenshot shows the PNG encode/decode state before reopening its heap. The earlier image-workbench.jpg remains preserved. The source and installed resource generation used for this capture has patch SHA-256 1e61c216c4635ad8eaa0ed24f8fd42f19d9dd4837ebf025e999598bd86172765. The later documentation update does not change those application assets. Python/JavaScript runtime notices and corresponding source remain included.

Capture SHA-256: `8265153bcdd2b68c3bac546c4a3ad2d1d1e9dab55b38631a2b0a072f66752922`.

Application asset identities at capture:

- `studio/app.js`: `21d2f2386f715b793477e459bcd76f9fd05b4e2a114ed24da597aa10e63eb47a`
- `studio/image-codec-core.mjs`: `d41da2adc7bf410a4fdaf38bb7a3f5014204838b824454769e5e4fb7f0326e51`
- `studio/image-codec.mjs`: `fc534608f37fe6656124970870d37068aa3276d606c004520a34917e13f8b56f`
- `studio/image.css`: `7654e6f4e81a91e72dab5a7380bb74a4ef4e832ef813d9616c1b5d9d09a40894`
- `studio/image.html`: `9b3f47c609c564ff7375fc6c313c0ab26bde53139a4b2065c99dd35e282809e9`
- `studio/image.mjs`: `50fa1752c6f301606a491a88dbe4fcc7230315ed758d2a606a62a9613512395c`
- `studio/index.html`: `9d7bc912aeb7a56a6bd2bef043f4a31078e05dc11cfd37da16fbaf61d0ae9f77`
- `studio/objects-model.mjs`: `4438ecb66dc49654ee4404dfbf2867412275c5dc154e895a18f210fccdb2102e`
- `studio/objects.css`: `3a9d23cb299ab8a9bc3d46de0c1263631799629cafb09e08114256e3cb2b84f2`
- `studio/objects.html`: `ec8221ea4e088ce6d209ece05146555f0d65c236722e221b6c776112efa729af`
- `studio/objects.js`: `c4f6af42398ec63f4a608c1e8d9c7897701c605df669b80b930a21242fbe13ce`
- `studio/styles.css`: `bac93c721ac7814f01a93843a8a7e92f84cee81b45b79ac4b8e235d5b15c354e`
