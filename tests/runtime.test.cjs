/* SPDX-License-Identifier: GPL-2.0-only */
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { runCapsule, validateCapsule } = require("../runtime/index.cjs");
const proof = path.resolve(__dirname, "../examples/lz4");
const minimal = (
  bytes = "c0035fd6",
  contract = { buffers: [], args: [], return: "i32" },
) => ({
  schema: 1,
  architecture: "arm64",
  artifactSHA256: "0".repeat(64),
  entry: 0,
  chunks: [{ kind: "code", address: 0, name: "entry", bytes }],
  imports: [],
  contract,
});
const rejectCode = (promise, code) =>
  assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `${e.code}: ${e.message}`);
    return true;
  });
const bufferContract = (access) => ({
  buffers: [{ name: "data", access, capacity: 1 }],
  args: [{ kind: "buffer", buffer: "data" }],
  return: "i32",
});
test("all 128 recorded independently native LZ4 controls", async () => {
  const capsule = JSON.parse(fs.readFileSync(path.join(proof, "capsule.json"))),
    receipt = JSON.parse(
      fs.readFileSync(path.join(proof, "native-oracle.json")),
    );
  assert.equal(receipt.verifiedCases, 128);
  assert.equal(capsule.artifactSHA256, receipt.artifactSHA256);
  for (const c of receipt.cases) {
    capsule.contract = {
      buffers: [
        { name: "source", access: "read", capacity: 65536 },
        {
          name: "destination",
          access: "readwrite",
          capacity: c.capacity ?? 4096,
        },
      ],
      args: [
        { kind: "buffer", buffer: "source" },
        { kind: "buffer", buffer: "destination" },
        { kind: "length", buffer: "source" },
        { kind: "capacity", buffer: "destination" },
      ],
      return: "i32",
      imports: ["memmove"],
    };
    const result = await runCapsule(
      capsule,
      { buffers: { source: c.compressed ?? c.malformed, destination: "" } },
      { traceLimit: 0 },
    );
    assert.equal(
      result.returnValue,
      c.return,
      JSON.stringify({ size: c.size, kind: c.kind, capacity: c.capacity }),
    );
    if (c.expectedOutput !== null && c.expectedOutput !== undefined)
      assert.equal(
        result.outputs.destination.slice(0, result.returnValue * 2),
        c.expectedOutput,
      );
    assert(result.stats.instructions > 0);
    assert.equal(result.outputs.destination.length, (c.capacity ?? 4096) * 2);
  }
});
test("exact schema and bounded addresses, spans and contracts", () => {
  const cases = [
    (c) => (c.schema = 2),
    (c) => (c.architecture = "x86"),
    (c) => (c.entry = 1),
    (c) => (c.entry = 4),
    (c) => (c.chunks[0].address = 0.5),
    (c) => (c.chunks[0].bytes = "c0035fd"),
    (c) => (c.chunks[0].bytes = "zzzzzzzz"),
    (c) => (c.chunks[0].address = 0x1000000),
    (c) => c.chunks.push({ ...c.chunks[0] }),
    (c) => (c.imports = [{ address: 0, name: "_memmove" }]),
    (c) => {
      c.imports = [{ address: 4, name: "_malloc" }];
    },
    (c) =>
      (c.contract.args = Array(9).fill({
        kind: "scalar",
        name: "x",
        type: "i32",
      })),
    (c) =>
      (c.contract.buffers = [
        { name: "__proto__", access: "read", capacity: 1 },
      ]),
    (c) => (c.contract.return = "float"),
    (c) =>
      (c.contract.buffers = [
        { name: "a", access: "read", capacity: 16777217 },
      ]),
  ];
  for (const mutate of cases) {
    const c = minimal();
    mutate(c);
    assert.throws(() => validateCapsule(c));
  }
  assert.throws(() =>
    validateCapsule(minimal("c0035fd6", bufferContract("read")), {
      buffers: { data: "0000" },
    }),
  );
  assert.throws(() =>
    validateCapsule(
      minimal("c0035fd6", {
        buffers: [],
        args: [{ kind: "scalar", name: "n", type: "u64" }],
        return: "u64",
      }),
      { scalars: { n: 9007199254740992 } },
    ),
  );
  assert.throws(() => validateCapsule(minimal(), { scalars: { extra: 1 } }));
});
test("signed and unsigned integer results including precise 64-bit strings", async () => {
  for (const [type, input, expected] of [
    ["i32", -7, -7],
    ["u32", 4294967295, 4294967295],
    ["i64", "-9223372036854775808", "-9223372036854775808"],
    ["u64", "18446744073709551615", "18446744073709551615"],
  ]) {
    const c = minimal("c0035fd6", {
      buffers: [],
      args: [{ kind: "scalar", name: "value", type }],
      return: type,
    });
    assert.equal(
      (await runCapsule(c, { scalars: { value: input } })).returnValue,
      expected,
    );
  }
});
test("logical code padding is never executable", async () => {
  await rejectCode(runCapsule(minimal("01000014")), "EXECUTION_BOUNDS");
});
test("logical readonly padding and buffer padding are inaccessible", async () => {
  const c = minimal("00044039c0035fd6", bufferContract("read"));
  await rejectCode(runCapsule(c, { buffers: { data: "7f" } }), "MEMORY_BOUNDS");
  const ro = minimal("8000001000044039c0035fd6");
  ro.chunks.push({
    kind: "readonly",
    address: 16,
    bytes: "00",
    name: "constant",
  });
  await rejectCode(runCapsule(ro), "MEMORY_BOUNDS");
});
test("buffer write and read permissions are enforced", async () => {
  await rejectCode(
    runCapsule(minimal("01000039c0035fd6", bufferContract("read")), {
      buffers: { data: "00" },
    }),
    "MEMORY_BOUNDS",
  );
  await rejectCode(
    runCapsule(minimal("00004039c0035fd6", bufferContract("write")), {
      buffers: { data: "" },
    }),
    "MEMORY_BOUNDS",
  );
  const result = await runCapsule(
    minimal("2105805201000039c0035fd6", bufferContract("write")),
    { buffers: { data: "" } },
  );
  assert.equal(result.outputs.data, "29");
  assert(result.trace.some((e) => e.kind === "write" && e.region === "data"));
});
test("code and readonly memory cannot be written", async () => {
  await rejectCode(
    runCapsule(minimal("0000001001000039c0035fd6")),
    "MEMORY_BOUNDS",
  );
  const c = minimal("8000001001000039c0035fd6");
  c.chunks.push({ kind: "readonly", address: 16, bytes: "00" });
  await rejectCode(runCapsule(c), "MEMORY_BOUNDS");
});
test("loop count, trace limit, host wall timer and cancellation", async () => {
  await rejectCode(
    runCapsule(
      minimal("00000014"),
      {},
      { instructionLimit: 17, traceLimit: 100 },
    ),
    "INSTRUCTION_LIMIT",
  );
  await rejectCode(
    runCapsule(
      minimal("00000014"),
      {},
      { instructionLimit: 100, traceLimit: 7 },
    ),
    "TRACE_LIMIT",
  );
  await rejectCode(
    runCapsule(
      minimal("00000014"),
      {},
      { instructionLimit: 10000000, timeoutMs: 1, traceLimit: 0 },
    ),
    "TIMEOUT",
  );
  const controller = new AbortController();
  const p = runCapsule(
    minimal("00000014"),
    {},
    { signal: controller.signal, traceLimit: 0, instructionLimit: 10000000 },
  );
  controller.abort();
  await rejectCode(p, "CANCELLED");
});
test("imports are explicit bounded models with memmove overlap semantics", async () => {
  const c = minimal("c0035fd6", {
    buffers: [{ name: "data", access: "readwrite", capacity: 4 }],
    args: [
      { kind: "buffer", buffer: "data" },
      { kind: "buffer", buffer: "data" },
      { kind: "scalar", name: "count", type: "u64" },
    ],
    return: "u64",
    imports: ["memmove"],
  });
  c.entry = 4;
  c.imports = [{ address: 4, name: "_memmove" }]; // Entry imports are rejected, so enter through branch.
  c.entry = 0;
  c.chunks[0].bytes = "01000014";
  const got = await runCapsule(c, {
    buffers: { data: "01020304" },
    scalars: { count: "4" },
  });
  assert.equal(got.outputs.data, "01020304");
  assert.equal(got.stats.imports.memmove, 1);
  assert(got.trace.some((e) => e.kind === "read" && e.model === "memmove"));
  await rejectCode(
    runCapsule(c, { buffers: { data: "01020304" }, scalars: { count: "5" } }),
    "MEMORY_BOUNDS",
  );
  c.contract.imports = [];
  await rejectCode(
    runCapsule(c, { buffers: { data: "01020304" }, scalars: { count: "4" } }),
    "UNSUPPORTED_IMPORT",
  );
});
test("read input length is enforced independently of its greater capacity", async () => {
  const c = minimal("00044039c0035fd6", {
    ...bufferContract("read"),
    buffers: [{ name: "data", access: "read", capacity: 4096 }],
  });
  await rejectCode(runCapsule(c, { buffers: { data: "7f" } }), "MEMORY_BOUNDS");
});
test("trace overflow retains only bounded diagnostics and exact count limit", async () => {
  await assert.rejects(
    runCapsule(
      minimal("00000014"),
      {},
      { traceLimit: 3, instructionLimit: 100 },
    ),
    (e) => {
      assert.equal(e.code, "TRACE_LIMIT");
      assert.equal(e.details.trace.length, 3);
      assert.equal(e.details.stats.instructions, 4);
      return true;
    },
  );
  await assert.rejects(
    runCapsule(
      minimal("00000014"),
      {},
      { traceLimit: 100, instructionLimit: 3 },
    ),
    (e) => {
      assert.equal(e.code, "INSTRUCTION_LIMIT");
      assert.equal(e.details.stats.instructions, 3);
      assert.equal(e.details.trace.length, 3);
      return true;
    },
  );
});
test("memmove snapshots overlaps and memcpy refuses the same overlap", async () => {
  const c = minimal("2104009101000014", {
    buffers: [{ name: "data", access: "readwrite", capacity: 4 }],
    args: [
      { kind: "buffer", buffer: "data" },
      { kind: "buffer", buffer: "data" },
      { kind: "scalar", name: "count", type: "u32" },
    ],
    return: "u64",
    imports: ["memmove"],
  });
  c.imports = [{ address: 8, name: "_memmove" }];
  assert.equal(
    (
      await runCapsule(c, {
        buffers: { data: "01020304" },
        scalars: { count: 3 },
      })
    ).outputs.data,
    "02030404",
  );
  c.imports[0].name = "memcpy";
  c.contract.imports = ["memcpy"];
  await rejectCode(
    runCapsule(c, { buffers: { data: "01020304" }, scalars: { count: 3 } }),
    "IMPORT_OVERLAP",
  );
});
test("memset uses the exact low byte of a 64-bit value", async () => {
  const c = minimal("01000014", {
    buffers: [{ name: "data", access: "write", capacity: 4 }],
    args: [
      { kind: "buffer", buffer: "data" },
      { kind: "scalar", name: "value", type: "u64" },
      { kind: "capacity", buffer: "data" },
    ],
    return: "u64",
    imports: ["memset"],
  });
  c.imports = [{ address: 4, name: "memset" }];
  const got = await runCapsule(c, {
    buffers: {},
    scalars: { value: "9007199254740993" },
  });
  assert.equal(got.outputs.data, "01010101");
  assert.equal(got.stats.imports.memset, 1);
});
test("import models obey read permissions and readonly data cannot execute", async () => {
  const c = minimal("01000014", {
    buffers: [{ name: "data", access: "write", capacity: 4 }],
    args: [
      { kind: "buffer", buffer: "data" },
      { kind: "buffer", buffer: "data" },
      { kind: "capacity", buffer: "data" },
    ],
    return: "i32",
    imports: ["memmove"],
  });
  c.imports = [{ address: 4, name: "memmove" }];
  await rejectCode(runCapsule(c, { buffers: {} }), "MEMORY_BOUNDS");
  const ro = minimal("01000014");
  ro.chunks.push({
    kind: "readonly",
    address: 4,
    bytes: "c0035fd6",
    name: "not_code",
  });
  await rejectCode(runCapsule(ro), "EXECUTION_BOUNDS");
});
