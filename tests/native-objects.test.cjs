/* SPDX-License-Identifier: GPL-2.0-only */
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { createModule, validateModule } = require("../runtime/objects.cjs");
const { identity, digest } = require("../runtime/object-core.js");
const fixture = path.join(__dirname, "fixtures/native-objects");
const original = JSON.parse(fs.readFileSync(path.join(fixture, "module.json"))),
  packets = JSON.parse(fs.readFileSync(path.join(fixture, "packets.json"))),
  oracle = JSON.parse(
    fs.readFileSync(path.join(fixture, "native-oracle.json")),
  );
const rejects = (p, code) =>
  assert.rejects(p, (e) => {
    assert.equal(e.code, code, `${e.code}: ${e.message}`);
    return true;
  });
async function handModule(bytes, entries, imports = []) {
  const m = {
    schema: "capsulith.module.v1",
    architecture: "arm64",
    artifactSHA256: "0".repeat(64),
    modelVersion: "capsulith.memory.v1",
    chunks: [
      { kind: "code", address: 0, bytes, name: "controlled instructions" },
    ],
    imports,
    entries,
  };
  m.id = await digest(identity(m));
  return m;
}
const rawHeap = () =>
  handModule(
    "0400001400004039c0035fd602000014",
    {
      allocate: {
        entry: 0,
        root: "controlled_allocate",
        args: ["u32"],
        return: "reference",
      },
      read: {
        entry: 4,
        root: "controlled_read",
        args: ["reference"],
        return: "u32",
      },
      free: {
        entry: 12,
        root: "controlled_free",
        args: ["reference"],
        return: "u64",
      },
    },
    [
      { address: 16, name: "malloc" },
      { address: 20, name: "free" },
    ],
  );
async function firstBlock(instance) {
  const created = await instance.call("create");
  assert.equal(created.stats.imports.malloc, 1);
  assert.equal(created.stats.imports.bzero, 1);
  assert.equal(created.stats.allocations[0].size, 16416);
  assert(
    created.trace.some(
      (e) => e.kind === "write" && e.model === "bzero" && e.size === 16416,
    ),
  );
  const heap = created.returnValue,
    src = await instance.allocateBuffer({
      name: "first",
      access: "read",
      capacity: 65536,
      bytes: packets.first,
    }),
    dst = await instance.allocateBuffer({
      name: "destination",
      access: "readwrite",
      capacity: 70000,
      bytes: "",
    });
  const result = await instance.call(
    "compress",
    [heap, src, dst, 65536, 70000, 1],
    { traceLimit: 0 },
  );
  assert.equal(result.returnValue, oracle.retained.first.return);
  assert.equal(
    result.outputs.destination.slice(0, result.returnValue * 2),
    oracle.retained.first.hex,
  );
  return { heap, src, dst, result };
}
async function secondBlock(instance, heap, dst) {
  const src = await instance.allocateBuffer({
    name: "second",
    access: "read",
    capacity: 32768,
    bytes: packets.second,
  });
  return instance.call("compress", [heap, src, dst, 32768, 70000, 1], {
    traceLimit: 0,
  });
}
test("actual native factory, retained-input checkpoint, fresh-worker continuation and free", async () => {
  let instance = await createModule(original);
  try {
    const state = await firstBlock(instance),
      cp = await instance.checkpoint(),
      savedHeap = cp.regions.find((r) => r.id === state.heap.regionId);
    assert.equal(savedHeap.capacity, 16416);
    assert.equal(savedHeap.initialized, "01".repeat(16416));
    const oldInstanceId = instance.instanceId;
    await instance.close();
    instance = await createModule(original, { checkpoint: cp });
    assert.notEqual(instance.instanceId, oldInstanceId);
    assert.equal(
      (await instance.checkpoint()).regions.find(
        (r) => r.id === state.src.regionId,
      ).address,
      cp.regions.find((r) => r.id === state.src.regionId).address,
    );
    await rejects(
      instance.call("compress", [
        state.heap,
        state.src,
        state.dst,
        65536,
        70000,
        1,
      ]),
      "REFERENCE",
    );
    const heap = instance.reference(state.heap.regionId),
      dst = instance.reference(state.dst.regionId),
      result = await secondBlock(instance, heap, dst);
    assert.equal(result.returnValue, oracle.retained.second.return);
    assert.equal(
      result.outputs.destination.slice(0, result.returnValue * 2),
      oracle.retained.second.hex,
    );
    assert(
      result.stats.regions[state.src.regionId].reads > 0,
      "actual native continuation must read retained history",
    );
    assert.deepEqual(result.trace, []);
    assert(result.stats.instructions > 0);
    const freed = await instance.call("free", [heap]);
    assert.equal(freed.returnValue, 0);
    assert.equal(freed.stats.imports.free, 1);
    await rejects(instance.call("free", [heap]), "REFERENCE");
    assert.equal(
      (await instance.checkpoint()).regions.filter((r) => r.kind === "heap")
        .length,
      0,
    );
  } finally {
    await instance.close();
  }
});
test("actual saveDict retires original caller input while preserving continuation", async () => {
  let instance = await createModule(original);
  try {
    const state = await firstBlock(instance),
      safe = await instance.allocateBuffer({
        name: "savedHistory",
        access: "readwrite",
        capacity: 65536,
        bytes: "",
      }),
      saved = await instance.call("save", [state.heap, safe, 65536], {
        traceLimit: 0,
      });
    assert.equal(saved.returnValue, 65536);
    assert.equal(saved.stats.imports.memmove, 1);
    await instance.releaseBuffer(state.src);
    const cp = await instance.checkpoint();
    assert(!cp.regions.some((r) => r.id === state.src.regionId));
    await instance.close();
    instance = await createModule(original, { checkpoint: cp });
    const result = await secondBlock(
      instance,
      instance.reference(state.heap.regionId),
      instance.reference(state.dst.regionId),
    );
    assert.equal(
      result.outputs.destination.slice(0, result.returnValue * 2),
      oracle.saved.second.hex,
    );
    assert(result.stats.regions[safe.regionId].reads > 0);
  } finally {
    await instance.close();
  }
});
test("independent actual stream on same second bytes differs from continued native history", async () => {
  const instance = await createModule(original);
  try {
    const heap = (await instance.call("create")).returnValue,
      dst = await instance.allocateBuffer({
        name: "destination",
        access: "readwrite",
        capacity: 70000,
        bytes: "",
      }),
      result = await secondBlock(instance, heap, dst);
    assert.equal(result.returnValue, oracle.fresh.return);
    assert.equal(
      result.outputs.destination.slice(0, result.returnValue * 2),
      oracle.fresh.hex,
    );
    assert.notEqual(result.returnValue, oracle.retained.second.return);
  } finally {
    await instance.close();
  }
});
test("module/checkpoint bind actual code, signatures and import model identity", async () => {
  const bad = structuredClone(original);
  bad.chunks[0].bytes = "c0035fd6";
  await rejects(validateModule(bad), "MODULE_ID");
  const instance = await createModule(original);
  let cp;
  try {
    await instance.call("create");
    cp = await instance.checkpoint();
  } finally {
    await instance.close();
  }
  const changed = structuredClone(cp);
  changed.regions[0].bytes = "a5" + changed.regions[0].bytes.slice(2);
  await rejects(
    createModule(original, { checkpoint: changed }),
    "CHECKPOINT_ID",
  );
  const wrong = structuredClone(cp);
  wrong.modelVersion = "guess";
  await rejects(createModule(original, { checkpoint: wrong }), "CHECKPOINT_ID");
  const overlap = structuredClone(cp);
  overlap.regions.push({ ...overlap.regions[0], id: "region2" });
  overlap.allocations = 2;
  overlap.nextId = 3;
  const { digest: discard, ...payload } = overlap;
  overlap.digest = await digest(payload);
  await rejects(createModule(original, { checkpoint: overlap }), "VALIDATION");
});
test("unknown heap reads poison native object; original constructor initialization is not fabricated", async () => {
  const instance = await createModule(await rawHeap());
  try {
    const heap = (await instance.call("allocate", [8])).returnValue,
      cp = await instance.checkpoint();
    assert.equal(cp.regions[0].bytes, "a5".repeat(8));
    assert.equal(cp.regions[0].initialized, "00".repeat(8));
    await rejects(instance.call("read", [heap]), "UNINITIALIZED_READ");
    await rejects(instance.checkpoint(), "POISONED");
    await rejects(instance.call("allocate", [8]), "POISONED");
  } finally {
    await instance.close();
  }
});
test("foreign, freed and interior free references are explicit lifetime errors", async () => {
  const one = await createModule(original),
    two = await createModule(original);
  try {
    const heap = (await one.call("create")).returnValue;
    await rejects(two.call("free", [heap]), "REFERENCE");
    const interior = one.reference(heap.regionId, 1);
    await rejects(one.call("free", [interior]), "REFERENCE");
    await rejects(one.checkpoint(), "POISONED");
    assert.equal((await two.call("create")).stats.imports.malloc, 1);
  } finally {
    await one.close();
    await two.close();
  }
});
test("allocation quota and snapshot restore quotas cannot produce successful state", async () => {
  const instance = await createModule(original, { maxHeapBytes: 8 });
  try {
    await rejects(instance.call("create"), "MEMORY_LIMIT");
    await rejects(instance.checkpoint(), "POISONED");
  } finally {
    await instance.close();
  }
  const source = await createModule(original);
  let cp;
  try {
    await source.call("create");
    cp = await source.checkpoint();
  } finally {
    await source.close();
  }
  await rejects(
    createModule(original, { checkpoint: cp, maxHeapBytes: 8 }),
    "MEMORY_LIMIT",
  );
});
test("host timeout, cancellation, instruction exhaustion and trace exhaustion discard the worker", async () => {
  const loop = await handModule("00000014", {
    loop: { entry: 0, root: "controlled_loop", args: [], return: "i32" },
  });
  for (const [options, code] of [
    [{ instructionLimit: 3, traceLimit: 100 }, "INSTRUCTION_LIMIT"],
    [{ instructionLimit: 100, traceLimit: 3 }, "TRACE_LIMIT"],
    [{ instructionLimit: 10000000, traceLimit: 0, timeoutMs: 1 }, "TIMEOUT"],
  ]) {
    const instance = await createModule(loop, {
      instructionLimit: 10000000,
      traceLimit: 100,
      timeoutMs: 5000,
    });
    try {
      await rejects(instance.call("loop", [], options), code);
      await rejects(instance.checkpoint(), "POISONED");
    } finally {
      await instance.close();
    }
  }
  const instance = await createModule(loop, {
    instructionLimit: 10000000,
    traceLimit: 0,
  });
  try {
    const controller = new AbortController(),
      p = instance.call("loop", [], { signal: controller.signal });
    setTimeout(() => controller.abort(), 1);
    await rejects(p, "CANCELLED");
    await rejects(instance.checkpoint(), "POISONED");
  } finally {
    await instance.close();
  }
});
test("omitting the actually referenced previous input fails continuation instead of inventing history", async () => {
  let instance = await createModule(original);
  try {
    const state = await firstBlock(instance);
    await instance.releaseBuffer(state.src);
    const cp = await instance.checkpoint();
    await instance.close();
    instance = await createModule(original, { checkpoint: cp });
    await rejects(
      secondBlock(
        instance,
        instance.reference(state.heap.regionId),
        instance.reference(state.dst.regionId),
      ),
      "MEMORY_BOUNDS",
    );
    await rejects(instance.checkpoint(), "POISONED");
  } finally {
    await instance.close();
  }
});
test("null destructor and caller initialization retain native and declared semantics", async () => {
  const instance = await createModule(original);
  try {
    const result = await instance.call("free", [null]);
    assert.equal(result.returnValue, 0);
    assert.deepEqual(result.stats.imports, {});
    const bytes = await instance.allocateBuffer({
      name: "initializedCaller",
      access: "readwrite",
      capacity: 4,
      bytes: "7f",
    });
    assert.equal(await instance.readBuffer(bytes), "7f000000");
    const readonly = await instance.allocateBuffer({
      name: "readonly",
      access: "read",
      capacity: 4,
      bytes: "7f",
    });
    await rejects(instance.readBuffer(readonly, 2), "MEMORY_BOUNDS");
    const cp = await instance.checkpoint();
    assert.equal(cp.regions.length, 2);
  } finally {
    await instance.close();
  }
});
test("checkpoint captures original ceilings and default restore cannot reopen an exhausted LZ4 call budget", async () => {
  const source = await createModule(original, {
    callLimit: 1,
    timeoutMs: 321,
    maxHeapBytes: 20000,
  });
  let cp, heap;
  try {
    heap = (await source.call("create")).returnValue;
    cp = await source.checkpoint();
    assert.equal(cp.calls, 1);
    assert.equal(cp.limits.callLimit, 1);
    assert.equal(cp.limits.timeoutMs, 321);
    assert.equal(cp.limits.maxHeapBytes, 20000);
  } finally {
    await source.close();
  }
  const resumed = await createModule(original, { checkpoint: cp });
  try {
    assert.deepEqual((await resumed.checkpoint()).limits, cp.limits);
    await rejects(
      resumed.call("free", [resumed.reference(heap.regionId)]),
      "INSTRUCTION_LIMIT",
    );
    await rejects(resumed.checkpoint(), "POISONED");
  } finally {
    await resumed.close();
  }
  for (const limits of [
    { callLimit: 2 },
    { timeoutMs: 400 },
    { maxHeapBytes: 25000 },
  ])
    await rejects(
      createModule(original, { checkpoint: cp, ...limits }),
      "LIMIT_INCREASE",
    );
});
test("partial restore overrides inherit every unmentioned ceiling and lower ceilings stay lowered on a second restore", async () => {
  const source = await createModule(original, {
    callLimit: 4,
    timeoutMs: 432,
    maxHeapBytes: 30000,
    maxBuffers: 3,
  });
  let cp, heap;
  try {
    heap = (await source.call("create")).returnValue;
    cp = await source.checkpoint();
  } finally {
    await source.close();
  }
  let resumed = await createModule(original, {
    checkpoint: cp,
    limits: { callLimit: 2 },
  });
  let narrowed;
  try {
    narrowed = await resumed.checkpoint();
    assert.deepEqual(narrowed.limits, { ...cp.limits, callLimit: 2 });
    assert.equal(
      (await resumed.call("free", [resumed.reference(heap.regionId)]))
        .returnValue,
      0,
    );
    narrowed = await resumed.checkpoint();
    assert.equal(narrowed.calls, 2);
  } finally {
    await resumed.close();
  }
  resumed = await createModule(original, { checkpoint: narrowed });
  try {
    assert.equal((await resumed.checkpoint()).limits.callLimit, 2);
    await rejects(resumed.call("free", [null]), "INSTRUCTION_LIMIT");
  } finally {
    await resumed.close();
  }
  await rejects(
    createModule(original, { checkpoint: narrowed, callLimit: 4 }),
    "LIMIT_INCREASE",
  );
});
test("lowered memory and consumed allocation/caller budgets must still accommodate the actual LZ4 state", async () => {
  const source = await createModule(original, {
    maxAllocations: 1,
    maxBuffers: 1,
    maxHeapBytes: 20000,
    maxBufferBytes: 10000,
    maxTotalBytes: 25000,
  });
  let cp;
  try {
    await source.call("create");
    await source.allocateBuffer({
      name: "retained",
      access: "read",
      capacity: 1000,
      bytes: "01",
    });
    cp = await source.checkpoint();
  } finally {
    await source.close();
  }
  await rejects(
    createModule(original, { checkpoint: cp, maxHeapBytes: 16415 }),
    "MEMORY_LIMIT",
  );
  await rejects(
    createModule(original, { checkpoint: cp, maxBufferBytes: 999 }),
    "MEMORY_LIMIT",
  );
  await rejects(
    createModule(original, { checkpoint: cp, maxTotalBytes: 17415 }),
    "MEMORY_LIMIT",
  );
  const fits = await createModule(original, {
    checkpoint: cp,
    maxHeapBytes: 16416,
    maxBufferBytes: 1000,
    maxTotalBytes: 17416,
  });
  try {
    const saved = await fits.checkpoint();
    assert.equal(saved.allocations, 1);
    assert.equal(saved.bufferAllocations, 1);
    await rejects(fits.call("create"), "MEMORY_LIMIT");
  } finally {
    await fits.close();
  }
  const buffers = await createModule(original, { checkpoint: cp });
  try {
    await rejects(
      buffers.allocateBuffer({
        name: "new",
        access: "readwrite",
        capacity: 1,
        bytes: "",
      }),
      "MEMORY_LIMIT",
    );
    await rejects(buffers.checkpoint(), "POISONED");
  } finally {
    await buffers.close();
  }
});
test("native total instruction usage survives restore and reduced ceilings cannot discard already consumed usage", async () => {
  const source = await createModule(original, { totalInstructionLimit: 17 });
  let cp, heap;
  try {
    heap = (await source.call("create")).returnValue;
    cp = await source.checkpoint();
    assert.equal(cp.totalInstructions, 17);
  } finally {
    await source.close();
  }
  const resumed = await createModule(original, { checkpoint: cp });
  try {
    assert.equal((await resumed.checkpoint()).limits.totalInstructionLimit, 17);
    await rejects(
      resumed.call("free", [resumed.reference(heap.regionId)]),
      "INSTRUCTION_LIMIT",
    );
  } finally {
    await resumed.close();
  }
  await rejects(
    createModule(original, { checkpoint: cp, totalInstructionLimit: 16 }),
    "VALIDATION",
  );
  await rejects(
    createModule(original, { checkpoint: cp, totalInstructionLimit: 18 }),
    "LIMIT_INCREASE",
  );
});
test("old or malformed captured-limit checkpoints refuse before guest mapping, and limits are digest-bound", async () => {
  const source = await createModule(original);
  let cp;
  try {
    await source.call("create");
    cp = await source.checkpoint();
  } finally {
    await source.close();
  }
  const old = structuredClone(cp);
  delete old.limits;
  await rejects(
    createModule(original, { checkpoint: old }),
    "CHECKPOINT_LIMITS",
  );
  const missing = structuredClone(cp);
  delete missing.limits.timeoutMs;
  await rejects(
    createModule(original, { checkpoint: missing }),
    "CHECKPOINT_LIMITS",
  );
  const bad = structuredClone(cp);
  bad.limits.callLimit = "1";
  await rejects(createModule(original, { checkpoint: bad }), "VALIDATION");
  const changed = structuredClone(cp);
  changed.limits.callLimit--;
  await rejects(
    createModule(original, { checkpoint: changed }),
    "CHECKPOINT_ID",
  );
  const { ObjectEngine } = require("../runtime/object-core.js");
  let maps = 0;
  const backend = async () => ({
    Unicorn: class {
      mem_map() {
        maps++;
      }
      close() {}
    },
  });
  await rejects(
    ObjectEngine.create(original, { checkpoint: changed }, backend),
    "CHECKPOINT_ID",
  );
  assert.equal(
    maps,
    0,
    "checkpoint binding must be validated before any code/guest mapping",
  );
});
test("prototype-inherited method names reject as unknown methods without poisoning a live LZ4 instance", async () => {
  const instance = await createModule(original);
  try {
    for (const name of [
      "toString",
      "hasOwnProperty",
      "valueOf",
      "isPrototypeOf",
    ])
      await rejects(instance.call(name, []), "VALIDATION");
    const created = await instance.call("create");
    assert.equal(created.stats.imports.malloc, 1);
    assert.equal((await instance.checkpoint()).calls, 1);
  } finally {
    await instance.close();
  }
});
