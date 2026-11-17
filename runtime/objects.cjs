/* SPDX-License-Identifier: GPL-2.0-only */
"use strict";
const { Worker } = require("node:worker_threads");
const { validateModule, CapsuleError } = require("./object-core.js");
const host = require("./object-host.js");
function connect(initialization, events) {
  const worker = new Worker(require.resolve("./object-worker.cjs"), {
    workerData: initialization,
  });
  worker.on("message", events.message);
  worker.on("error", (err) =>
    events.failure(new CapsuleError("WORKER_ERROR", err.message)),
  );
  worker.on("exit", events.exit);
  return {
    postMessage: (message) => worker.postMessage(message),
    initialize: () => {},
    terminate: () => worker.terminate().catch(() => {}),
  };
}
function createModule(module, options = {}) {
  return host.createModule(module, options, connect);
}
module.exports = { createModule, validateModule, CapsuleError };
