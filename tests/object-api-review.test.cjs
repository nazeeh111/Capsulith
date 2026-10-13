/* SPDX-License-Identifier: GPL-2.0-only */
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  vm = require("node:vm"),
  crypto = require("node:crypto");
const { createModule } = require("../runtime/objects.cjs");
const { ObjectEngine, digest, identity } = require("../runtime/object-core.js");
const original = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/native-objects/module.json")),
);
const rejects = (p, code) =>
  assert.rejects(p, (e) => {
    assert.equal(e.code, code, `${e.code}: ${e.message}`);
    return true;
  });
async function refusedCreate(options, code) {
  let accepted;
  try {
    await rejects(
      createModule(original, options).then((i) => (accepted = i)),
      code,
    );
  } finally {
    await accepted?.close();
  }
}
// Handwritten ABI control only. The original licensed LZ4 artifact remains the defining capability proof.
async function abiModule() {
  const m = {
    schema: "capsulith.module.v1",
    architecture: "arm64",
    artifactSHA256: "0".repeat(64),
    modelVersion: "capsulith.memory.v1",
    chunks: [
      {
        kind: "code",
        address: 0,
        bytes: "0000018bc0035fd600004039c0035fd6",
        name: "ABI endpoint return and byte load",
      },
    ],
    imports: [],
    entries: {
      advance: {
        entry: 0,
        root: "ABI_control_advance",
        args: ["reference", "u32"],
        return: "reference",
      },
      read: {
        entry: 8,
        root: "ABI_control_read",
        args: ["reference"],
        return: "u32",
      },
    },
  };
  m.id = await digest(identity(m));
  return m;
}
function browserCore() {
  const context = vm.createContext({
    crypto: crypto.webcrypto,
    TextEncoder,
    performance,
  });
  context.self = context;
  for (const file of ["core.js", "object-core.js"])
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, "../runtime", file), "utf8"),
      context,
    );
  return context.CapsulithObjectsCore;
}
test("ABI one-past-end return is a valid owned reference while dereference still fails", async () => {
  const instance = await createModule(await abiModule());
  try {
    const data = await instance.allocateBuffer({
      name: "bytes",
      access: "readwrite",
      capacity: 4,
      bytes: "01020304",
    });
    const returned = (await instance.call("advance", [data, 4])).returnValue;
    assert.equal(returned.regionId, data.regionId);
    assert.equal(returned.offset, 4);
    assert.deepEqual(returned, instance.reference(data.regionId, 4));
    await rejects(instance.call("read", [returned]), "MEMORY_BOUNDS");
  } finally {
    await instance.close();
  }
});
test("fresh and restored nested limit typos reject consistently before backend creation", async () => {
  await refusedCreate({ limits: { callLmit: 1 } }, "VALIDATION");
  const source = await createModule(original);
  let cp;
  try {
    cp = await source.checkpoint();
  } finally {
    await source.close();
  }
  await refusedCreate(
    { checkpoint: cp, limits: { callLmit: 1 } },
    "VALIDATION",
  );
  let factories = 0;
  await rejects(
    ObjectEngine.create(original, { limits: { callLmit: 1 } }, async () => {
      factories++;
      return {
        Unicorn: class {
          close() {}
        },
      };
    }),
    "VALIDATION",
  );
  assert.equal(factories, 0);
});
test("valid-digest checkpoint duplicate caller names reject before any restored guest mapping", async () => {
  const source = await createModule(original);
  let cp;
  try {
    await source.call("create");
    await source.allocateBuffer({
      name: "left",
      access: "readwrite",
      capacity: 4,
      bytes: "01020304",
    });
    await source.allocateBuffer({
      name: "right",
      access: "readwrite",
      capacity: 4,
      bytes: "05060708",
    });
    cp = await source.checkpoint();
  } finally {
    await source.close();
  }
  const caller = cp.regions.filter((r) => r.kind === "buffer");
  caller[1].name = caller[0].name;
  const { digest: discard, ...payload } = cp;
  cp.digest = await digest(payload);
  await refusedCreate({ checkpoint: cp }, "VALIDATION");
  let maps = 0;
  await rejects(
    ObjectEngine.create(original, { checkpoint: cp }, async () => ({
      Unicorn: class {
        mem_map() {
          maps++;
        }
        mem_write() {}
        close() {}
      },
    })),
    "VALIDATION",
  );
  assert.equal(maps, 0);
});
test("browser-global shared core preserves the same endpoint, fresh-limit and duplicate-name rules", async () => {
  const browser = browserCore(),
    m = await abiModule();
  const plan = await browser.validateModule(m);
  const fake = new browser.ObjectEngine(plan, {
    Unicorn: class {
      close() {}
    },
  });
  try {
    fake.regions.set("region1", {
      id: "region1",
      live: true,
      address: 0x4000000,
      capacity: 4,
    });
    const ref = fake.pointer(0x4000004);
    assert.equal(ref.offset, 4);
    assert.throws(
      () => fake.locate(0x4000004, 1, "read"),
      (e) => e.code === "MEMORY_BOUNDS",
    );
  } finally {
    fake.close();
  }
  await rejects(
    browser.validateModule(original, { limits: { callLmit: 1 } }),
    "VALIDATION",
  );
  const source = await createModule(original);
  let cp;
  try {
    await source.allocateBuffer({
      name: "one",
      access: "readwrite",
      capacity: 1,
      bytes: "01",
    });
    await source.allocateBuffer({
      name: "two",
      access: "readwrite",
      capacity: 1,
      bytes: "02",
    });
    cp = await source.checkpoint();
  } finally {
    await source.close();
  }
  cp.regions[1].name = cp.regions[0].name;
  const { digest: discard, ...payload } = cp;
  cp.digest = await digest(payload);
  let maps = 0;
  await rejects(
    browser.ObjectEngine.create(original, { checkpoint: cp }, async () => ({
      Unicorn: class {
        mem_map() {
          maps++;
        }
        mem_write() {}
        close() {}
      },
    })),
    "VALIDATION",
  );
  assert.equal(maps, 0);
});
