/* SPDX-License-Identifier: GPL-2.0-only */
"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const { execute } = require("./core.js");
const factory = require("./vendor/unicorn_aarch64.js");
execute(workerData, factory).then(
  (result) => parentPort.postMessage({ ok: true, result }),
  (err) =>
    parentPort.postMessage({
      ok: false,
      error: {
        code: err.code || "WORKER_ERROR",
        message: err.message || String(err),
        details: err.details || {},
      },
    }),
);
