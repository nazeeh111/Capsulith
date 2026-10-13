/* SPDX-License-Identifier: GPL-2.0-only */
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm"),
  crypto = require("node:crypto");
const { createModule } = require("../runtime/objects.cjs");
const factory = require("../runtime/vendor/unicorn_aarch64.js");
const fixture = path.join(__dirname, "fixtures/native-objects"),
  moduleData = JSON.parse(fs.readFileSync(path.join(fixture, "module.json"))),
  packets = JSON.parse(fs.readFileSync(path.join(fixture, "packets.json"))),
  oracle = JSON.parse(
    fs.readFileSync(path.join(fixture, "native-oracle.json")),
  );
function browserBranch(platformCrypto = crypto.webcrypto) {
  const context = vm.createContext({
    crypto: platformCrypto,
    TextEncoder,
    performance,
  });
  context.self = context;
  for (const file of ["core.js", "object-core.js"])
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "../runtime", file), "utf8"),
      context,
      { filename: file },
    );
  assert.equal(context.require, undefined);
  assert.equal(context.Buffer, undefined);
  return context.CapsulithObjectsCore;
}
test("browser-global core uses standard WebCrypto with byte-identical UTF8 identity encoding", async () => {
  const browser = browserBranch();
  const value = { z: "π😀\u0000", a: ["ASCII", "é"] };
  const expected = crypto
    .createHash("sha256")
    .update(JSON.stringify({ a: value.a, z: value.z }), "utf8")
    .digest("hex");
  assert.equal(await browser.digest(value), expected);
  assert.equal(
    (await browser.validateModule(moduleData)).module.id,
    moduleData.id,
  );
  const unsupported = browserBranch({ randomUUID: () => crypto.randomUUID() });
  await assert.rejects(
    unsupported.validateModule(moduleData),
    (e) => e.code === "CRYPTO_UNAVAILABLE",
  );
});
test("Node-worker native object checkpoint continues byte-exactly through browser-global shared execution branch", async () => {
  const source = await createModule(moduleData);
  let cp, heap, dst, src;
  try {
    heap = (await source.call("create")).returnValue;
    src = await source.allocateBuffer({
      name: "first",
      access: "read",
      capacity: 65536,
      bytes: packets.first,
    });
    dst = await source.allocateBuffer({
      name: "destination",
      access: "readwrite",
      capacity: 70000,
      bytes: "",
    });
    const first = await source.call(
      "compress",
      [heap, src, dst, 65536, 70000, 1],
      { traceLimit: 0 },
    );
    assert.equal(
      first.outputs.destination.slice(0, first.returnValue * 2),
      oracle.retained.first.hex,
    );
    cp = await source.checkpoint();
  } finally {
    await source.close();
  }
  const browser = browserBranch(),
    resumed = await browser.ObjectEngine.create(
      moduleData,
      { checkpoint: cp },
      factory,
    );
  try {
    assert.notEqual(resumed.instanceId, heap.instanceId);
    const second = resumed.allocateBuffer({
      name: "second",
      access: "read",
      capacity: 32768,
      bytes: packets.second,
    });
    const result = resumed.call(
      "compress",
      [
        resumed.reference(heap.regionId),
        second,
        resumed.reference(dst.regionId),
        32768,
        70000,
        1,
      ],
      { traceLimit: 0 },
    );
    assert.equal(result.returnValue, oracle.retained.second.return);
    assert.equal(
      result.outputs.destination.slice(0, result.returnValue * 2),
      oracle.retained.second.hex,
    );
    assert(result.stats.regions[src.regionId].readBytes > 0);
    const restored = await resumed.checkpoint();
    assert.deepEqual(JSON.parse(JSON.stringify(restored.limits)), cp.limits);
    assert.equal(
      restored.regions.find((r) => r.id === heap.regionId).initialized,
      "01".repeat(16416),
    );
    assert.equal(
      resumed.call("free", [resumed.reference(heap.regionId)]).returnValue,
      0,
    );
    assert.equal(
      (await resumed.checkpoint()).regions.filter((r) => r.kind === "heap")
        .length,
      0,
    );
  } finally {
    resumed.close();
  }
});
