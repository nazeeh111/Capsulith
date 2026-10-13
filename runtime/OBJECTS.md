# Portable native objects

An object module combines selected original ARM64 method closures, explicit caller-declared signatures and supported memory imports. Each instance owns one persistent Wasm worker, allocated heap and caller regions. Original function capsules continue to use `index.cjs` / `browser.mjs` and schema1; their per-call behavior is unchanged.

## Create, call and restore

Node 20+:

```js
const { createModule } = require('./runtime/objects.cjs');
const instance = await createModule(module, { limits: { traceLimit: 0 } });
try {
  const stream = (await instance.call('create', [])).returnValue;
  const source = await instance.allocateBuffer({
    name: 'input', access: 'read', capacity: 65536, bytes: packetHex
  });
  const destination = await instance.allocateBuffer({
    name: 'output', access: 'readwrite', capacity: 70000, bytes: ''
  });
  const result = await instance.call('compress',
    [stream, source, destination, 65536, 70000, 1]);
  // Component-specific integer errors remain the caller's responsibility.
  if (result.returnValue <= 0) throw new Error('LZ4 compression failed');
  const checkpoint = await instance.checkpoint();
  await instance.close();
  const restored = await createModule(module, { checkpoint });
  try {
    const rebound = restored.reference(stream.regionId, stream.offset);
    // This free method belongs to the declared LZ4 contract, not every module.
    await restored.call('free', [rebound]);
  } finally { await restored.close(); }
} finally { await instance.close(); }
```

Browser code imports `createModule` from `./runtime/objects.mjs`. Serve the entire exported directory through HTTP on localhost or HTTPS: built-in WebCrypto, same-origin worker/scripts and Wasm compilation are required. The browser creates `object-browser-worker.js`. No server executes the original artifact. A worker supports cancellation and keeps work off the UI thread; it is not an emulator security-isolation claim.

## Module and caller contracts

`capsulith.module.v1` has architecture `arm64`, `modelVersion: capsulith.memory.v1`, an original `artifactSHA256`, exact `chunks`, declared `imports`, flat named `entries` and an `id`. Each entry is `{entry, root, args, return}`. Python extraction accepts a methods mapping `{name: {root, args, return}}`; the original entry address is resolved during extraction. One to 32 named methods and at most eight integer-register arguments per method are supported. Signatures are supplied by the caller, never inferred from symbol names.

Argument/return types are `reference`, `i32`, `u32`, `i64`, `u64`. Use JavaScript integer numbers for 32-bit values and decimal strings for 64-bit values. A reference is `{instanceId, regionId, offset}` for a live owned region, or `null`. Native pointer returns must identify a live owned region or null. References from another instance, including the pre-restore instance, are rejected.

The module identity hashes sorted compact JSON of schema, architecture, original artifact digest, memory model, chunks, imports and entries. Display extraction evidence is excluded. Only declared `malloc`, `bzero`, `free`, `memcpy`, `memmove`, `memset` imports are modeled. These are bounded guest-memory operations, without OS access, arbitrary callbacks or native host loading. Selected components must fit direct control flow, readonly static data and explicitly modeled dependencies. Writable static state, relocated static pointer data, indirect control flow and unsupported artifact families remain outside this scope. No object layout or pointer scan-and-rewrite is performed.

## Instance methods

Operations serialize in the dedicated worker. All methods below are asynchronous except `reference`, `instanceId` and `status`.

| Operation | Behavior |
| --- | --- |
| `allocateBuffer({name, access, capacity, bytes})` | Returns an owned base reference. Bytes are exact hex; access is read/write/readwrite. Names must be unique among live caller buffers. |
| `call(name, args, options?)` | Executes original selected instructions and returns `{returnValue, outputs, trace, stats}`. Options may reduce instruction/trace/deadline limits and include an AbortSignal. |
| `readBuffer(ref, length?)` | Returns bounded hex, requiring read permission and initialized heap bytes. Default length is remaining capacity. |
| `releaseBuffer(baseRef)` | Explicitly retires caller memory. Refuses null, an interior reference or a heap allocation. |
| `checkpoint()` | Captures successful live owned state at the method boundary. |
| `reference(regionId, offset=0)` | Rebinds a live region to this instance. Validates identity and offset without interpreting fields. |
| `close()` | Terminates the worker and awaits shutdown. Repeated close is harmless. |
| `instanceId` / `status` | Current identity and lifecycle state; live, poisoned or closed after startup. |

Read-only caller buffers permit reads only within supplied input bytes. Write buffers prohibit reads. Readwrite caller buffers permit reads/writes through capacity. Remaining caller capacity starts at zero. Native heap allocations start with unknown initialization; actual machine writes or modeled writes mark initialized bytes. Unknown heap reads refuse execution. Studio previews use `??` for unknown heap bytes rather than present poison values as meaningful state.

`outputs` contains full-capacity hex for all live writable caller buffers, never inferred heap fields. A native integer return does not automatically identify the meaningful output slice. Trace events identify actual addresses, sizes, named regions, IDs, offsets and memory import models. Stats retain instruction/access/byte/import/allocation/free counts and named region intervals even when `traceLimit: 0` disables event recording. The read/write intervals have exclusive upper bounds and may enclose gaps; they are not an exhaustive list of touched bytes. Nonzero event-limit exhaustion faults instead of silently discarding evidence.

## Lifetimes, checkpoints and recovery

The caller controls buffer lifetimes. A native object may retain guest pointers to earlier inputs; do not mutate or release those regions until the component's declared API permits it. For LZ4, earlier input must remain unchanged at the same address, or `saveDict` must copy history into retained caller memory before releasing it. Native `free` retires an owned heap allocation. It does not release separate caller buffers. Freed addresses are not reused within an instance.

`capsulith.checkpoint.v1` binds module/model identity, origin instance ID, live region IDs/addresses/names/kinds/capacities/access/read bounds/bytes, heap initialization, allocation/address counters, consumed work and all configured limits. Restore preserves guest addresses and region IDs without rewriting stored pointers. Its fresh instance identity prevents accidental references crossing clones; rebind explicit known references with `reference`.

The checkpoint digest covers captured limits and state to detect accidental alteration; it is not authentication or proof of equivalence for deliberately edited state. Checkpoints are method-boundary snapshots of owned memory and counters, not arbitrary CPU/stack or mid-instruction snapshots. They contain all retained caller bytes, so inspect them before sharing.

Restore inherits all captured ceilings when omitted. Explicit overrides may only lower ceilings; an oversized state or consumed quota exceeding a lowered ceiling is rejected. Counters survive restore, so restore cannot reset work quotas. Old unreleased prototype checkpoints without complete captured limits are refused.

Keep a prior checkpoint separately before a risky operation. Native faults, quota exhaustion, unknown heap reads, invalid native free, host deadlines and cancellation poison or terminate the instance; subsequent calls/checkpoints refuse. Restore a prior matching checkpoint into a new instance or start fresh. Pre-execution signature/reference validation errors reject without mutating a live object. Component-specific native integer errors, such as LZ4 compression returning zero, require the caller's declared recovery rule; they are not a universal runtime error convention.

## Limits

Use `createModule(module, {limits: {...}, checkpoint?, signal?})`. Per-call `instructionLimit`, `traceLimit`, `timeoutMs` only reduce the instance ceilings. All allocation/call counters count over the instance's lifetime, including restored history.

| Limit field | Default | Maximum |
| --- | ---: | ---: |
| `timeoutMs` | 5,000 | 60,000 |
| `instructionLimit` | 1,000,000 | 10,000,000 |
| `traceLimit` | 10,000 | 200,000 |
| `stackBytes` | 65,536 | 1,048,576 |
| `maxHeapBytes` | 8 MiB | 8 MiB |
| `maxBufferBytes` | 16 MiB | 16 MiB |
| `maxTotalBytes` | 16 MiB | 16 MiB |
| `maxAllocations` | 1,024 | 1,024 |
| `maxBuffers` | 64 | 64 |
| `callLimit` | 1,000 | 10,000 |
| `totalInstructionLimit` | 20,000,000 | 100,000,000 |

Stack bytes use 4,096-byte units. Combined live heap and caller memory obeys `maxTotalBytes`. Original code/readonly chunk validation keeps the existing bounded function limits. Host deadlines include worker/startup operations and forcibly terminate stalled work; Unicorn's internal timeout remains zero with this pinned backend.

## Generic operation files

The included Node runner takes a `capsulith.operations.v1` JSON program with at most 256 operations, optional `limits`, and a 60-second whole-program ceiling:

```json
{
  "schema": "capsulith.operations.v1",
  "operations": [
    {"op":"call", "method":"create", "args":[], "as":"object"},
    {"op":"allocate", "as":"source", "spec":{"name":"input","access":"read","capacity":3,"bytes":"010203"}},
    {"op":"call", "method":"free", "args":[{"use":"object"}]},
    {"op":"release", "reference":{"use":"source"}}
  ]
}
```

These `create`/`free` names are examples from the LZ4 contract. Use the actual named lifecycle methods in your module. `as` binds an allocation/reference result or a call's returned value; `{use: "alias"}` resolves it. Restore uses `{"op":"reference","as":"object","regionId":"region1","offset":0}` to rebind a known owned region. `read` takes `reference` and optional `length`; call `options` accepts reduced work limits. Unknown fields, duplicate aliases and missing references are refused.

```sh
node runtime/object-cli.cjs operations.json --module module.json \
  --checkpoint-out NEW-checkpoint.json
node runtime/object-cli.cjs continue.json --module module.json \
  --checkpoint NEW-checkpoint.json
```

In a portable folder use `node run.cjs operations.json` with the same options. Checkpoint output refuses an existing destination and is written only after successful operations. An exported empty starter intentionally does not guess the module lifecycle. In a source checkout, `examples/native-objects/README.md` documents the actual initialized LZ4 example.

Object document readers and checkpoint files are bounded to 64 MiB. Modules
are bounded to 24 MiB in exports. Object ZIP export accepts up to 96 MiB of JSON
at its loopback endpoint and 96 MiB of uncompressed packaged files, including
corresponding backend source. The descriptor references module.json and
checkpoint.json once, avoiding duplicate state bytes. Existing single-function
endpoints and object extraction retain the 48 MiB request limit. Oversized inputs
or exports are refused explicitly, with no truncation or overwritten output.

The operation runner emits compact JSON and enforces its 64 MiB encoded-result
budget before retaining each record. Exceeding it stops the program with
`OUTPUT_LIMIT`, closes the instance, and writes no successful checkpoint.
