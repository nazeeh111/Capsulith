/* SPDX-License-Identifier: GPL-2.0-only */
"use strict";
const { Worker } = require("node:worker_threads");
const { validate, CapsuleError } = require("./core.js");
function runCapsule(capsule, inputs = {}, options = {}) {
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
      worker = new Worker(require.resolve("./worker.cjs"), {
        workerData: plan,
      });
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
    worker.once("message", (message) => {
      if (message.ok) finish(null, message.result);
      else
        finish(
          new CapsuleError(
            message.error.code,
            message.error.message,
            message.error.details,
          ),
        );
    });
    worker.once("error", (err) =>
      finish(new CapsuleError("WORKER_ERROR", err.message)),
    );
    worker.once("exit", (code) => {
      if (!settled)
        finish(
          new CapsuleError(
            "WORKER_ERROR",
            `Worker exited before returning a result (code ${code})`,
          ),
        );
    });
    if (options.signal?.aborted) abort();
  });
}
module.exports = { runCapsule, validateCapsule: validate, CapsuleError };
