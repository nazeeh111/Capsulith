/* SPDX-License-Identifier: GPL-2.0-only */
import "./core.js";
import "./object-core.js";
import "./object-host.js";
const { validateModule, CapsuleError } = globalThis.CapsulithObjectsCore;
const host = globalThis.CapsulithObjectsHost;
export { validateModule, CapsuleError };
function connect(initialization, events) {
  const worker = new Worker(new URL("./object-browser-worker.js", import.meta.url));
  worker.onmessage = (event) => events.message(event.data);
  worker.onerror = (event) => {
    event.preventDefault();
    events.failure(
      new CapsuleError("WORKER_ERROR", event.message || "Object worker failed"),
    );
  };
  worker.onmessageerror = () =>
    events.failure(
      new CapsuleError("WORKER_ERROR", "Object worker response could not be decoded"),
    );
  return {
    postMessage: (message) => worker.postMessage(message),
    initialize: () => worker.postMessage({ init: true, ...initialization }),
    terminate: async () => worker.terminate(),
  };
}
export function createModule(module, options = {}) {
  return host.createModule(module, options, connect);
}
