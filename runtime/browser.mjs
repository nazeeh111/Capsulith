/* SPDX-License-Identifier: GPL-2.0-only */
import "./core.js";
const { validate, CapsuleError } = globalThis.CapsulithCore;
export { CapsuleError };
export const validateCapsule = validate;
export function runCapsule(capsule, inputs = {}, options = {}) {
  return new Promise((resolve, reject) => {
    let plan;
    try {
      plan = validate(capsule, inputs, options);
    } catch (err) {
      reject(err);
      return;
    }
    if (options.signal?.aborted) {
      reject(new CapsuleError("CANCELLED", "Execution cancelled"));
      return;
    }
    let worker;
    try {
      worker = new Worker(new URL("./worker.js", import.meta.url));
    } catch (err) {
      reject(new CapsuleError("WORKER_ERROR", err.message || String(err)));
      return;
    }
    let settled = false;
    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (err) reject(err);
      else resolve(result);
    };
    const abort = () =>
      finish(new CapsuleError("CANCELLED", "Execution cancelled"));
    const timer = setTimeout(
      () =>
        finish(
          new CapsuleError(
            "TIMEOUT",
            `Host terminated worker after ${plan.settings.timeoutMs} ms`,
            { timeoutMs: plan.settings.timeoutMs },
          ),
        ),
      plan.settings.timeoutMs,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.ok) finish(null, message.result);
      else
        finish(
          new CapsuleError(
            message.error.code,
            message.error.message,
            message.error.details,
          ),
        );
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(
        new CapsuleError("WORKER_ERROR", event.message || "Worker failed"),
      );
    };
    worker.onmessageerror = () =>
      finish(
        new CapsuleError(
          "WORKER_ERROR",
          "Worker response could not be decoded",
        ),
      );
    try {
      worker.postMessage(plan);
    } catch (err) {
      finish(new CapsuleError("WORKER_ERROR", err.message || String(err)));
    }
    if (options.signal?.aborted) abort();
  });
}
