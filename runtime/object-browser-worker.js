/* SPDX-License-Identifier: GPL-2.0-only */
"use strict";
importScripts("./core.js", "./object-core.js", "./vendor/unicorn_aarch64.js");
let engine,
  started = false;
const metadata = () => ({
  instanceId: engine.instanceId,
  poisoned: engine.poisoned,
  regions: [...engine.regions.values()]
    .filter((r) => r.live)
    .map((r) => ({
      regionId: r.id,
      capacity: r.capacity,
      kind: r.kind,
      name: r.name,
      address: r.address,
      access: r.access,
    })),
});
const error = (err) => ({
  code: err.code || "WORKER_ERROR",
  message: err.message || String(err),
  details: err.details || {},
});
self.onmessage = async (event) => {
  const message = event.data;
  if (!started) {
    started = true;
    try {
      if (message.init !== true) throw Error("Expected module initialization");
      engine = await CapsulithObjectsCore.ObjectEngine.create(
        message.module,
        message.options,
        MUnicorn,
      );
      self.postMessage({ ready: true, ...metadata() });
    } catch (err) {
      self.postMessage({ ready: false, error: error(err) });
      self.close();
    }
    return;
  }
  try {
    let result;
    switch (message.operation) {
      case "allocateBuffer":
        result = engine.allocateBuffer(message.value);
        break;
      case "releaseBuffer":
        result = engine.releaseBuffer(message.value);
        break;
      case "readBuffer":
        result = engine.readBuffer(message.value, message.length);
        break;
      case "call":
        result = engine.call(message.name, message.args, message.options);
        break;
      case "checkpoint":
        result = await engine.checkpoint();
        break;
      default:
        throw Error("Unknown object worker operation");
    }
    self.postMessage({ id: message.id, ok: true, result, ...metadata() });
  } catch (err) {
    if (err.code === "MEMORY_LIMIT" || err.code === "INSTRUCTION_LIMIT")
      engine.poisoned = true;
    self.postMessage({
      id: message.id,
      ok: false,
      error: error(err),
      ...metadata(),
    });
    if (engine.poisoned) {
      engine.close();
      self.close();
    }
  }
};
