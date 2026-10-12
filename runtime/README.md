# Capsulith execution runtime

This folder is portable. It needs Node.js with worker threads, WebAssembly and BigInt, or a browser serving the files over HTTP. It does not need Python, Capstone, the original binary or an installed package. Original runtime code and the combined distribution are GPL-2.0-only. See `vendor/` for the pinned backend, license and corresponding source.

```js
const { runCapsule } = require('./runtime/index.cjs');
const result = await runCapsule(capsule, {
  buffers: { source: '010203', destination: '' },
  scalars: { seed: 123 }
}, { timeoutMs: 5000, instructionLimit: 1000000, traceLimit: 10000 });
console.log(result.returnValue, result.outputs, result.stats);
```

Browser code imports `runCapsule` from `./runtime/browser.mjs`. It creates an external `worker.js`; serve the entire runtime folder at its relative location. A content security policy must allow these same-origin worker/script files and WebAssembly compilation. No capsule is executed on the server. A worker provides termination and keeps execution off the UI thread; it is not a claim of a security boundary against emulator or browser vulnerabilities.

## Declared contract

The capsule must have `schema: 1`, `architecture: "arm64"`, a 64-character hexadecimal `artifactSHA256`, integer `entry`, non-overlapping `chunks` and optional `imports`. Chunk `kind` is `code` or `readonly`, `address` is its original offset, `bytes` is exact hexadecimal, and optional `name` labels traces. Code addresses and lengths must be aligned to four bytes. The entry must be inside code. An artifact digest describes provenance; it does not authenticate a capsule.

```json
{
  "buffers": [
    { "name": "source", "access": "read", "capacity": 65536 },
    { "name": "destination", "access": "readwrite", "capacity": 4096 }
  ],
  "args": [
    { "kind": "buffer", "buffer": "source" },
    { "kind": "buffer", "buffer": "destination" },
    { "kind": "length", "buffer": "source" },
    { "kind": "capacity", "buffer": "destination" }
  ],
  "return": "i32",
  "imports": ["memmove"]
}
```

Attach this object as `capsule.contract`. Up to eight argument objects fill ARM64 registers X0 through X7 in order. `buffer` means its allocated pointer, `length` means supplied input bytes, and `capacity` means declared bytes. A scalar argument is `{ "kind": "scalar", "name": "seed", "type": "u32" }`. Types are `i32`, `u32`, `i64`, `u64`. The 32-bit values use integer JavaScript numbers. All 64-bit inputs and returns use decimal strings, preserving every bit. Supply scalar values in `inputs.scalars`, and buffer bytes as hex in `inputs.buffers`. Undeclared input names are rejected.

Read buffers permit reads only within actual supplied bytes. Write buffers permit writes within capacity and forbid reads. Readwrite buffers allow both throughout capacity; unprovided bytes start at zero. Previously written output often needs to be read, so a decompression destination generally uses readwrite. Write inputs may be omitted; read/readwrite inputs must be present, even if empty. Returned `outputs` includes complete capacity-sized hex for writable buffers. The contract does not infer how much output is meaningful from the function result.

Only `memmove`, `memcpy` and `memset` are modeled, and each used model must be explicitly enabled in `contract.imports`. Capsule imports identify aligned addresses and exact names with an optional leading underscore. Models read X0 destination, X1 source or fill value, X2 size, then return through the preserved guest LR. Every nonzero model access obeys the same logical bounds and permissions as machine instructions. `memcpy` rejects overlap; `memmove` snapshots bytes before writing. There are no arbitrary import callbacks, OS access or host allocation imports.

## Execution and evidence limits

Code pages are RX, readonly pages R, buffer pages use declared access, and a separate bounded stack is RW. Logical checks enforce exact chunk/buffer ranges even when the emulator maps a larger page. Code padding, readonly data, buffers and stack are not executable. Mapping overlapping code and readonly logical ranges into one physical page does not make readonly bytes executable.

Options are bounded: `timeoutMs` 1 to 60000 (default 5000), `instructionLimit` 1 to 10000000 (default 1000000), `traceLimit` 0 to 200000 (default 10000), `stackBytes` 4096 to 1048576 in 4096-byte units (default 65536). There are hard ceilings of 8 MiB chunk bytes, 16 MiB chunk address span, 16 MiB total buffer capacity, 4096 chunks, 1024 imports and 64 buffers.

The host starts a wall timer before posting work and forcibly terminates the worker on expiry. Pass an `AbortSignal` as `options.signal` to cancel. Unicorn's internal emulation timeout is always zero because this pinned Wasm build aborts when its timeout thread is used. A separate instruction budget stops loops.

Successful results contain `returnValue`, `outputs`, `trace` and `stats`. Trace events include kind, numeric emulated address, size, named region, stable region ID and offset; import accesses also identify the model. Stats include instructions, reads, writes, byte counts and import counts. The default trace budget stops execution with `TRACE_LIMIT` instead of silently dropping evidence. Setting `traceLimit: 0` explicitly disables recording; counts remain available. Elapsed stats time covers backend execution, while the host timeout also covers worker/backend startup.

Failures reject with `CapsuleError` and a `code`, `message` and `details`. Execution faults include bounded partial trace/stats and address diagnostics. Codes include `VALIDATION`, `UNSUPPORTED_IMPORT`, `MEMORY_BOUNDS`, `EXECUTION_BOUNDS`, `IMPORT_OVERLAP`, `INSTRUCTION_LIMIT`, `TRACE_LIMIT`, `EMULATOR_ERROR`, `WORKER_ERROR`, `TIMEOUT` and `CANCELLED`. Timeout/cancellation cannot recover the final in-worker trace because the worker is forcibly terminated. Failed executions return no successful buffer outputs.
