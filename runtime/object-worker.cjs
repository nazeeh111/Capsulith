/* SPDX-License-Identifier: GPL-2.0-only */
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { ObjectEngine } = require("./object-core.js");
const factory = require("./vendor/unicorn_aarch64.js");
let engine;
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
ObjectEngine.create(workerData.module, workerData.options, factory).then(
  (value) => {
    engine = value;
    parentPort.postMessage({ ready: true, ...metadata() });
    parentPort.on("message", async (message) => {
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
        parentPort.postMessage({
          id: message.id,
          ok: true,
          result,
          ...metadata(),
        });
      } catch (err) {
        if (err.code === "MEMORY_LIMIT" || err.code === "INSTRUCTION_LIMIT")
          engine.poisoned = true;
        parentPort.postMessage({
          id: message.id,
          ok: false,
          error: {
            code: err.code || "WORKER_ERROR",
            message: err.message || String(err),
            details: err.details || {},
          },
          ...metadata(),
        });
        if (engine.poisoned) {
          engine.close();
          parentPort.close();
        }
      }
    });
  },
  (err) => {
    parentPort.postMessage({
      ready: false,
      error: {
        code: err.code || "WORKER_ERROR",
        message: err.message || String(err),
        details: err.details || {},
      },
    });
    parentPort.close();
  },
);
