/* SPDX-License-Identifier: GPL-2.0-only */
"use strict";
importScripts("./core.js", "./vendor/unicorn_aarch64.js");
self.onmessage = async (event) => {
  try {
    const result = await CapsulithCore.execute(event.data, MUnicorn);
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({
      ok: false,
      error: {
        code: err.code || "WORKER_ERROR",
        message: err.message || String(err),
        details: err.details || {},
      },
    });
  }
};
