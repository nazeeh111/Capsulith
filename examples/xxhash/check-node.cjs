/* SPDX-License-Identifier: GPL-2.0-only */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { runCapsule } = require("../../runtime/index.cjs");
const oracle = JSON.parse(
  fs.readFileSync(path.join(__dirname, "oracle.json"), "utf8"),
);
const vectors = new Map(oracle.vectors.map((v) => [v.id, v]));
const distinct = oracle.cases.filter((c) => c.nativePointerModulo16 === 0);
(async () => {
  const began = performance.now(),
    artifacts = [];
  for (const opt of ["o2", "o1"]) {
    const filename = path.join(__dirname, `xxh32-${opt}.capsule.json`),
      capsule = JSON.parse(fs.readFileSync(filename, "utf8"));
    let count = 0,
      instructions = 0,
      reads = 0,
      maxInstructions = 0;
    for (const c of distinct) {
      const v = vectors.get(c.vector),
        result = await runCapsule(
          capsule,
          { buffers: { input: v.inputHex }, scalars: { seed: c.seedU32 } },
          { instructionLimit: 500000, traceLimit: 0, timeoutMs: 10000 },
        );
      assert.equal(
        result.returnValue,
        c.returnU32,
        `${opt}: ${c.vector} seed=${c.seedU32}`,
      );
      assert.deepEqual(result.outputs, {});
      assert.ok(result.stats.instructions > 0);
      count++;
      instructions += result.stats.instructions;
      reads += result.stats.reads;
      maxInstructions = Math.max(maxInstructions, result.stats.instructions);
      if (count % 100 === 0)
        process.stdout.write(
          `${opt}: ${count}/${distinct.length} actual worker calls verified\n`,
        );
    }
    artifacts.push({
      optimization: opt,
      verifiedCases: count,
      capsuleSHA256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(filename))
        .digest("hex"),
      artifactSHA256: capsule.artifactSHA256,
      codeBytes: capsule.extraction.codeBytes,
      imports: capsule.imports,
      totalInstructions: instructions,
      totalReads: reads,
      maxInstructions,
    });
  }
  const receipt = {
    status:
      "verified production Node worker and Unicorn.js Wasm runtime against independently compiled native O2/O1 oracle",
    node: process.version,
    verifiedExecutions: artifacts.reduce((n, a) => n + a.verifiedCases, 0),
    artifacts,
    seconds: (performance.now() - began) / 1000,
    limits: { instructionLimit: 500000, traceLimit: 0, timeoutMs: 10000 },
    alignmentScope:
      "All 2200 native cases exercised real pointer residues0/1/3/7. Product Node buffer pointers are aligned;550 unique input/seed combinations were executed percompiled capsule. No claim that the production ABI supports configurablepointeroffsets.",
  };
  const receiptPath = process.argv[2];
  if (receiptPath)
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", {
      flag: "wx",
    });
  process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
