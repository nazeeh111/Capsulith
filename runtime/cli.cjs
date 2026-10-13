/* SPDX-License-Identifier: GPL-2.0-only */
const fs = require("node:fs");
const { runCapsule } = require("./index.cjs");
try {
  const capsule = JSON.parse(fs.readFileSync(process.argv[2])),
    inputs = JSON.parse(fs.readFileSync(process.argv[3]));
  runCapsule(capsule, inputs, { traceLimit: Number(process.argv[4] ?? 0) })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(
        JSON.stringify({
          code: error.code,
          message: error.message,
          details: error.details,
        }),
      );
      process.exitCode = 1;
    });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
