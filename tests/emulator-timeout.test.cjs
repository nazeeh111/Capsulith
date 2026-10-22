/* SPDX-License-Identifier: GPL-2.0-only */
"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const { validate, execute } = require("../runtime/core.js");
const { ObjectEngine } = require("../runtime/object-core.js");
const objectModule = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, "fixtures/native-objects/module.json"),
    "utf8",
  ),
);

function minimalCapsule() {
  return {
    schema: 1,
    architecture: "arm64",
    artifactSHA256: "0".repeat(64),
    entry: 0,
    chunks: [{ kind: "code", address: 0, name: "entry", bytes: "c0035fd6" }],
    imports: [],
    contract: { buffers: [], args: [], return: "i32" },
  };
}

function backendFactory(starts) {
  const symbols = {
    ARCH_ARM64: 1,
    MODE_ARM: 2,
    PROT_READ: 1,
    PROT_WRITE: 2,
    PROT_EXEC: 4,
    HOOK_CODE: 1,
    HOOK_MEM_READ: 2,
    HOOK_MEM_WRITE: 4,
    HOOK_MEM_READ_UNMAPPED: 8,
    HOOK_MEM_WRITE_UNMAPPED: 16,
    HOOK_MEM_FETCH_UNMAPPED: 32,
    HOOK_MEM_READ_PROT: 64,
    HOOK_MEM_WRITE_PROT: 128,
    HOOK_MEM_FETCH_PROT: 256,
    MEM_WRITE: 1,
    ARM64_REG_SP: 1,
    ARM64_REG_LR: 2,
    ARM64_REG_CPACR_EL1: 3,
    ARM64_REG_X0: 4,
    ARM64_REG_PC: 5,
  };
  let nextHook = 0;
  class FakeUnicorn {
    constructor() {
      this.registers = new Map();
    }
    mem_map() {}
    mem_write() {}
    mem_read(_address, size) {
      return new Uint8Array(size);
    }
    reg_write_i64(register, value) {
      this.registers.set(register, BigInt(value));
    }
    reg_read_i64(register) {
      return this.registers.get(register) ?? 0n;
    }
    hook_add() {
      return ++nextHook;
    }
    hook_del() {}
    emu_start(begin, until, timeoutMicroseconds, instructionCount) {
      starts.push({ begin, until, timeoutMicroseconds, instructionCount });
      // This vendored Wasm backend aborts when its internal timeout thread starts.
      if (timeoutMicroseconds !== 0)
        throw new Error("the vendored Wasm backend does not support timeouts");
      this.registers.set(symbols.ARM64_REG_PC, BigInt(until));
    }
    emu_stop() {}
    close() {}
  }
  return async () => ({ ...symbols, Unicorn: FakeUnicorn });
}

test("both runtime entry points keep the vendored emulator timeout disabled", async () => {
  const capsuleStarts = [],
    plan = validate(minimalCapsule());
  await execute(plan, backendFactory(capsuleStarts));
  assert.equal(capsuleStarts.length, 1);
  assert.equal(capsuleStarts[0].timeoutMicroseconds, 0);
  assert.equal(
    capsuleStarts[0].instructionCount,
    plan.settings.instructionLimit + 1,
  );

  const objectStarts = [],
    engine = await ObjectEngine.create(
      objectModule,
      {},
      backendFactory(objectStarts),
    );
  try {
    const result = engine.call("create", []);
    assert.equal(result.returnValue, null);
    assert.equal(objectStarts.length, 1);
    assert.equal(objectStarts[0].timeoutMicroseconds, 0);
    assert.equal(
      objectStarts[0].instructionCount,
      engine.limits.instructionLimit + 1,
    );
  } finally {
    engine.close();
  }
});
