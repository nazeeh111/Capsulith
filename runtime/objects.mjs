/* SPDX-License-Identifier: GPL-2.0-only */
import "./core.js";
import "./object-core.js";
const { validateModule, identity, CapsuleError } =
  globalThis.CapsulithObjectsCore;
export { validateModule, CapsuleError };
function signalCheck(signal) {
  if (
    signal !== undefined &&
    (!signal ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")
  )
    throw new CapsuleError("VALIDATION", "signal must be an AbortSignal");
}
export async function createModule(module, options = {}) {
  signalCheck(options.signal);
  const plan = await validateModule(module, options),
    limits = plan.limits;
  if (options.signal?.aborted)
    throw new CapsuleError("CANCELLED", "Module creation cancelled");
  let worker;
  try {
    worker = new Worker(new URL("./object-browser-worker.js", import.meta.url));
  } catch (err) {
    throw new CapsuleError("WORKER_ERROR", err.message);
  }
  let status = "starting",
    instanceId,
    regions = new Map(),
    nextId = 1,
    pending = null,
    queue = Promise.resolve();
  const update = (m) => {
    instanceId = m.instanceId;
    regions = new Map((m.regions ?? []).map((r) => [r.regionId, r]));
  };
  const termination = async () => worker.terminate();
  const stopped = (err) => {
    if (status === "closed") return;
    status = "poisoned";
    termination();
    if (pending) {
      const p = pending;
      pending = null;
      p.finish(err);
    }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    stopped(
      new CapsuleError("WORKER_ERROR", event.message || "Object worker failed"),
    );
  };
  worker.onmessageerror = () =>
    stopped(
      new CapsuleError(
        "WORKER_ERROR",
        "Object worker response could not be decoded",
      ),
    );
  worker.onmessage = (event) => {
    const m = event.data;
    if (!pending) return;
    if (status === "starting") {
      if (m.ready) {
        update(m);
        status = "live";
        const p = pending;
        pending = null;
        p.finish(null);
      } else if (m.error) {
        const p = pending;
        pending = null;
        status = "poisoned";
        termination();
        p.finish(
          new CapsuleError(m.error.code, m.error.message, m.error.details),
        );
      }
      return;
    }
    if (m.id !== pending.id) return;
    update(m);
    const p = pending;
    pending = null;
    if (m.ok) p.finish(null, m.result);
    else {
      if (m.poisoned) {
        status = "poisoned";
        termination();
      }
      p.finish(
        new CapsuleError(m.error.code, m.error.message, m.error.details),
      );
    }
  };
  function waitFor(operation, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (err, result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (err) reject(err);
        else resolve(result);
      };
      const abort = () =>
        stopped(
          new CapsuleError(
            "CANCELLED",
            "Module operation cancelled; instance discarded",
          ),
        );
      const timer = setTimeout(
        () =>
          stopped(
            new CapsuleError(
              "TIMEOUT",
              `Host terminated object worker after ${timeoutMs} ms`,
              { timeoutMs },
            ),
          ),
        timeoutMs,
      );
      pending = { id: operation?.id, finish };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        if (operation) worker.postMessage(operation);
        else
          worker.postMessage({
            init: true,
            module: { ...identity(module), id: module.id },
            options: {
              limits,
              ...(options.checkpoint !== undefined
                ? { checkpoint: options.checkpoint }
                : {}),
            },
          });
      } catch (err) {
        stopped(new CapsuleError("WORKER_ERROR", err.message));
      }
    });
  }
  await waitFor(null, limits.timeoutMs, options.signal);
  const check = () => {
    if (status !== "live")
      throw new CapsuleError(
        status === "closed" ? "CLOSED" : "POISONED",
        "Module instance is no longer usable; restore a prior checkpoint",
      );
  };
  const request = (operation, callOptions = {}) => {
    const action = async () => {
      check();
      signalCheck(callOptions.signal);
      const timeoutMs = callOptions.timeoutMs ?? limits.timeoutMs;
      if (
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > limits.timeoutMs
      )
        throw new CapsuleError(
          "VALIDATION",
          "Call timeout exceeds module deadline",
        );
      if (callOptions.signal?.aborted) {
        stopped(
          new CapsuleError(
            "CANCELLED",
            "Module operation cancelled; instance discarded",
          ),
        );
        throw new CapsuleError(
          "CANCELLED",
          "Module operation cancelled; instance discarded",
        );
      }
      return waitFor(
        { ...operation, id: nextId++ },
        timeoutMs,
        callOptions.signal,
      );
    };
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  return {
    get instanceId() {
      return instanceId;
    },
    get status() {
      return status;
    },
    allocateBuffer: (spec) =>
      request({ operation: "allocateBuffer", value: spec }),
    releaseBuffer: (ref) => request({ operation: "releaseBuffer", value: ref }),
    readBuffer: (ref, length) =>
      request({ operation: "readBuffer", value: ref, length }),
    call: (name, args = [], callOptions = {}) =>
      request(
        {
          operation: "call",
          name,
          args,
          options: {
            ...(callOptions.instructionLimit !== undefined
              ? { instructionLimit: callOptions.instructionLimit }
              : {}),
            ...(callOptions.traceLimit !== undefined
              ? { traceLimit: callOptions.traceLimit }
              : {}),
          },
        },
        callOptions,
      ),
    checkpoint: () => request({ operation: "checkpoint" }),
    reference: (regionId, offset = 0) => {
      check();
      const r = regions.get(regionId);
      if (
        !r ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > r.capacity
      )
        throw new CapsuleError(
          "REFERENCE",
          "Reference does not identify a live owned region",
        );
      return { instanceId, regionId, offset };
    },
    close: async () => {
      if (status === "closed") return;
      status = "closed";
      if (pending) {
        const p = pending;
        pending = null;
        p.finish(new CapsuleError("CLOSED", "Module instance closed"));
      }
      await termination();
    },
  };
}
