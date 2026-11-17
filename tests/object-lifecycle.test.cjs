/* SPDX-License-Identifier: GPL-2.0-only */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/native-objects/module.json")));
// Deterministic transport faults supplement, rather than replace, the real-worker ABI tests.
function adapter({ ready = true, constructError = false, send } = {}) {
  let worker, made;
  const created = new Promise((resolve) => { made = resolve; });
  class Worker extends EventEmitter {
    constructor() {
      super();
      if (constructError) throw new Error("synthetic constructor failure");
      worker = this;
      this.terminations = 0;
      this.sent = [];
      made(this);
      if (ready) queueMicrotask(() => this.emit("message", { ready: true, instanceId: "owned-fixture", regions: [] }));
    }
    postMessage(message) {
      this.sent.push(message);
      if (send) send(this, message);
      else queueMicrotask(() => this.emit("message", { id: message.id, ok: true, instanceId: "owned-fixture", regions: [], result: message.operation }));
    }
    terminate() { this.terminations++; return Promise.resolve(0); }
  }
  const file = path.join(__dirname, "../runtime/objects.cjs");
  const local = createRequire(file);
  const requireFixture = (name) => name === "node:worker_threads" ? { Worker } : local(name);
  requireFixture.resolve = local.resolve;
  const context = { require: requireFixture, module: { exports: {} }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  return { create: (options = {}) => context.module.exports.createModule(fixture, options), created, get worker() { return worker; } };
}
const code = (expected) => (err) => { assert.equal(err.code, expected); return true; };
test("constructor and startup errors reject without exposing an instance", async () => {
  await assert.rejects(adapter({ constructError: true }).create(), code("WORKER_ERROR"));
  const f = adapter({ ready: false });
  const pending = f.create();
  const w = await f.created;
  w.emit("message", { error: { code: "CHECKPOINT", message: "synthetic invalid checkpoint" } });
  await assert.rejects(pending, code("CHECKPOINT"));
  assert.equal(w.terminations, 1);
});
test("unexpected exit and worker error terminate startup and settle only once", async () => {
  for (const event of ["exit", "error"]) {
    const f = adapter({ ready: false });
    const pending = f.create();
    const w = await f.created;
    w.emit(event, event === "exit" ? 7 : new Error("synthetic worker error"));
    await assert.rejects(pending, code("WORKER_ERROR"));
    w.emit("message", { ready: true, instanceId: "late", regions: [] });
    assert.equal(w.terminations, 1);
  }
});
test("pre-abort creates no worker, and startup abort discards its worker", async () => {
  const c = new AbortController(); c.abort();
  const before = adapter();
  await assert.rejects(before.create({ signal: c.signal }), code("CANCELLED"));
  assert.equal(before.worker, undefined);
  const during = adapter({ ready: false });
  const controller = new AbortController();
  const pending = during.create({ signal: controller.signal });
  const w = await during.created; controller.abort();
  await assert.rejects(pending, code("CANCELLED"));
  assert.equal(w.terminations, 1);
});
test("startup deadline discards a worker that never becomes ready", async () => {
  const f = adapter({ ready: false });
  await assert.rejects(f.create({ timeoutMs: 10 }), code("TIMEOUT"));
  assert.equal(f.worker.terminations, 1);
});
test("recoverable reply errors and mismatched replies preserve serialized reuse", async () => {
  let calls = 0;
  const f = adapter({ send(w, m) {
    calls++;
    w.emit("message", { id: m.id + 1, ok: true, result: "wrong request" });
    queueMicrotask(() => w.emit("message", calls === 1
      ? { id: m.id, ok: false, error: { code: "REFERENCE", message: "synthetic recoverable fault" } }
      : { id: m.id, ok: true, result: "next result", instanceId: "owned-fixture", regions: [] }));
  } });
  const api = await f.create();
  try {
    const first = api.call("first"); const second = api.call("second");
    await assert.rejects(first, code("REFERENCE"));
    assert.equal(await second, "next result"); assert.equal(api.status, "live");
    assert.deepEqual(f.worker.sent.map((m) => m.id), [1, 2]);
  } finally { await api.close(); }
});
test("send failure and call abort poison the instance and reject queued reuse", async () => {
  for (const failure of ["send", "abort"]) {
    const f = adapter({ send() { if (failure === "send") throw new Error("synthetic clone failure"); } });
    const api = await f.create(); const c = new AbortController();
    const first = api.call("first", [], { signal: c.signal });
    // The queued sentinel executes after the first action has posted its request.
    await Promise.resolve();
    const second = api.call("second");
    if (failure === "abort") c.abort();
    await assert.rejects(first, code(failure === "send" ? "WORKER_ERROR" : "CANCELLED"));
    await assert.rejects(second, code("POISONED"));
    assert.equal(api.status, "poisoned"); assert.equal(f.worker.sent.length, 1);
    await api.close();
  }
});
test("close rejects pending and queued work, ignores late replies and is idempotent", async () => {
  const f = adapter({ send() {} }); const api = await f.create();
  const pending = api.call("first"); await Promise.resolve();
  const queued = api.call("second"); await api.close();
  await assert.rejects(pending, code("CLOSED")); await assert.rejects(queued, code("CLOSED"));
  f.worker.emit("message", { id: 1, ok: true, result: "late" });
  f.worker.emit("exit", 0); await api.close();
  assert.equal(api.status, "closed"); assert.equal(f.worker.terminations, 1);
});
