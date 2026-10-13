/* SPDX-License-Identifier: GPL-2.0-only */
(function (root) {
  "use strict";
  const PAGE = 4096,
    BASE = 0x1000000,
    BUFFER_BASE = 0x4000000,
    STACK = 0x20000000,
    STOP = 0x30000000;
  const HARD = {
    codeSpan: 0x1000000,
    chunkBytes: 8 * 1024 * 1024,
    bufferBytes: 16 * 1024 * 1024,
    chunks: 4096,
    imports: 1024,
    buffers: 64,
    instructions: 10000000,
    trace: 200000,
  };
  class CapsuleError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = "CapsuleError";
      this.code = code;
      this.details = details;
    }
  }
  const fail = (code, message, details) => {
    throw new CapsuleError(code, message, details);
  };
  const object = (x, label) => {
    if (!x || typeof x !== "object" || Array.isArray(x))
      fail("VALIDATION", `${label} must be an object`);
    return x;
  };
  const integer = (x, min, max, label) => {
    if (!Number.isSafeInteger(x) || x < min || x > max)
      fail("VALIDATION", `${label} must be an integer in [${min}, ${max}]`);
    return x;
  };
  const name = (x, label) => {
    if (
      typeof x !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(x) ||
      ["__proto__", "constructor", "prototype"].includes(x)
    )
      fail("VALIDATION", `${label} is invalid`);
    return x;
  };
  function bytes(hex, label, limit) {
    if (
      typeof hex !== "string" ||
      hex.length > limit * 2 ||
      hex.length % 2 ||
      !/^[0-9a-fA-F]*$/.test(hex)
    )
      fail(
        "VALIDATION",
        `${label} must be exact even-length hexadecimal within byte limit`,
      );
    const a = new Uint8Array(hex.length / 2);
    for (let i = 0; i < a.length; i++)
      a[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return a;
  }
  function hex(a) {
    let s = "";
    for (let i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, "0");
    return s;
  }
  function scalar(value, type, label) {
    if (!["i32", "u32", "i64", "u64"].includes(type))
      fail("VALIDATION", `${label}: unsupported scalar type`);
    let n;
    if (type.endsWith("64")) {
      if (
        typeof value !== "string" ||
        !/^-?(0|[1-9][0-9]*)$/.test(value) ||
        value.length > 21
      )
        fail("VALIDATION", `${label}: 64-bit values require decimal strings`);
      n = BigInt(value);
    } else {
      integer(
        value,
        type === "i32" ? -2147483648 : 0,
        type === "i32" ? 2147483647 : 4294967295,
        label,
      );
      n = BigInt(value);
    }
    const bits = type.endsWith("64") ? 64n : 32n,
      signed = type.startsWith("i"),
      min = signed ? -(1n << (bits - 1n)) : 0n,
      max = signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
    if (n < min || n > max) fail("VALIDATION", `${label}: scalar out of range`);
    return n;
  }
  function validate(capsule, inputs = {}, options = {}) {
    object(capsule, "capsule");
    object(inputs, "inputs");
    object(options, "options");
    if (
      options.signal !== undefined &&
      (!options.signal ||
        typeof options.signal.aborted !== "boolean" ||
        typeof options.signal.addEventListener !== "function" ||
        typeof options.signal.removeEventListener !== "function")
    ) {
      fail("VALIDATION", "signal must be an AbortSignal");
    }
    if (capsule.schema !== 1 || capsule.architecture !== "arm64")
      fail("VALIDATION", "Only schema 1 arm64 capsules are supported");
    if (
      typeof capsule.artifactSHA256 !== "string" ||
      !/^[a-fA-F0-9]{64}$/.test(capsule.artifactSHA256)
    )
      fail("VALIDATION", "artifactSHA256 must be 64 hexadecimal characters");
    if (
      !Array.isArray(capsule.chunks) ||
      !capsule.chunks.length ||
      capsule.chunks.length > HARD.chunks
    )
      fail("VALIDATION", "Invalid chunk count");
    let total = 0;
    const regions = capsule.chunks.map((c, index) => {
      object(c, "chunk");
      if (!["code", "readonly"].includes(c.kind))
        fail("VALIDATION", "Unknown chunk kind");
      const address = integer(c.address, 0, HARD.codeSpan - 1, "chunk.address");
      const data = bytes(c.bytes, "chunk.bytes", HARD.chunkBytes);
      total += data.length;
      if (
        !data.length ||
        total > HARD.chunkBytes ||
        address + data.length > HARD.codeSpan
      )
        fail("VALIDATION", "Chunk byte/span budget exceeded");
      if (c.kind === "code" && (address % 4 || data.length % 4))
        fail("VALIDATION", "Code chunks must be 4-byte aligned");
      if (
        c.name !== undefined &&
        (typeof c.name !== "string" || c.name.length > 256)
      )
        fail("VALIDATION", "Invalid chunk name");
      return {
        address: BASE + address,
        size: data.length,
        data,
        kind: c.kind,
        id: `chunk:${index}`,
        name: c.name || `chunk${index}`,
        read: true,
        write: false,
        execute: c.kind === "code",
      };
    });
    const contract = object(capsule.contract, "contract");
    if (
      !Array.isArray(contract.buffers) ||
      contract.buffers.length > HARD.buffers
    )
      fail("VALIDATION", "Invalid buffer count");
    if (!Array.isArray(contract.args) || contract.args.length > 8)
      fail("VALIDATION", "At most eight register arguments are supported");
    if (!["i32", "u32", "i64", "u64"].includes(contract.return))
      fail("VALIDATION", "Invalid return type");
    const allowed = contract.imports === undefined ? [] : contract.imports;
    if (
      !Array.isArray(allowed) ||
      allowed.length > 3 ||
      new Set(allowed).size !== allowed.length ||
      allowed.some((n) => !["memmove", "memcpy", "memset"].includes(n))
    )
      fail(
        "VALIDATION",
        "Only explicitly declared memmove/memcpy/memset imports are supported",
      );
    const imports = capsule.imports === undefined ? [] : capsule.imports;
    if (!Array.isArray(imports) || imports.length > HARD.imports)
      fail("VALIDATION", "Invalid import count");
    const importRegions = imports.map((i, index) => {
      object(i, "import");
      const address = integer(
        i.address,
        0,
        HARD.codeSpan - 4,
        "import.address",
      );
      if (address % 4) fail("VALIDATION", "Import address must be aligned");
      if (
        typeof i.name !== "string" ||
        !/^_?(memmove|memcpy|memset)$/.test(i.name)
      )
        fail(
          "UNSUPPORTED_IMPORT",
          `Unsupported import ${String(i.name).slice(0, 100)}`,
        );
      const model = i.name.replace(/^_/, "");
      if (!allowed.includes(model))
        fail(
          "UNSUPPORTED_IMPORT",
          `Import ${i.name} requires explicit contract declaration`,
        );
      return {
        address: BASE + address,
        size: 4,
        data: Uint8Array.from([0xc0, 0x03, 0x5f, 0xd6]),
        kind: "import",
        id: `import:${index}`,
        name: i.name,
        model,
        read: true,
        write: false,
        execute: true,
      };
    });
    regions.push(...importRegions);
    regions.sort((a, b) => a.address - b.address);
    for (let i = 1; i < regions.length; i++)
      if (regions[i].address < regions[i - 1].address + regions[i - 1].size)
        fail("VALIDATION", "Chunk/import ranges overlap");
    const entry = BASE + integer(capsule.entry, 0, HARD.codeSpan - 4, "entry");
    if (
      entry % 4 ||
      !regions.some(
        (r) =>
          r.kind === "code" &&
          entry >= r.address &&
          entry + 4 <= r.address + r.size,
      )
    )
      fail("VALIDATION", "Entry must be aligned inside logical code");
    const inputBuffers =
        inputs.buffers === undefined
          ? {}
          : object(inputs.buffers, "inputs.buffers"),
      inputScalars =
        inputs.scalars === undefined
          ? {}
          : object(inputs.scalars, "inputs.scalars");
    let next = BUFFER_BASE,
      bufferTotal = 0;
    const names = new Set();
    const buffers = contract.buffers.map((b) => {
      object(b, "buffer");
      name(b.name, "buffer.name");
      if (names.has(b.name)) fail("VALIDATION", "Duplicate buffer name");
      names.add(b.name);
      if (!["read", "write", "readwrite"].includes(b.access))
        fail("VALIDATION", "Invalid buffer access");
      const capacity = integer(
        b.capacity,
        0,
        HARD.bufferBytes,
        "buffer.capacity",
      );
      bufferTotal += capacity;
      if (bufferTotal > HARD.bufferBytes)
        fail("VALIDATION", "Total buffer byte budget exceeded");
      if (!Object.hasOwn(inputBuffers, b.name) && b.access !== "write")
        fail("VALIDATION", `Missing input buffer ${b.name}`);
      const data = bytes(
        Object.hasOwn(inputBuffers, b.name) ? inputBuffers[b.name] : "",
        `buffer ${b.name}`,
        capacity,
      );
      const mapped = Math.max(PAGE, Math.ceil(capacity / PAGE) * PAGE);
      const r = {
        address: next,
        size: capacity,
        readSize: b.access === "read" ? data.length : capacity,
        data,
        kind: "buffer",
        id: `buffer:${b.name}`,
        name: b.name,
        access: b.access,
        read: b.access !== "write",
        write: b.access !== "read",
        execute: false,
        mapped,
      };
      next += mapped + PAGE;
      return r;
    });
    for (const key of Object.keys(inputBuffers))
      if (!names.has(key)) fail("VALIDATION", `Undeclared input buffer ${key}`);
    const scalarNames = new Set();
    const args = contract.args.map((a) => {
      object(a, "argument");
      if (["buffer", "length", "capacity"].includes(a.kind)) {
        const b = buffers.find((b) => b.name === a.buffer);
        if (!b) fail("VALIDATION", "Argument references unknown buffer");
        return BigInt(
          a.kind === "buffer"
            ? b.address
            : a.kind === "length"
              ? b.data.length
              : b.size,
        );
      }
      if (a.kind === "scalar") {
        name(a.name, "scalar.name");
        scalarNames.add(a.name);
        if (!Object.hasOwn(inputScalars, a.name))
          fail("VALIDATION", `Missing scalar ${a.name}`);
        return scalar(inputScalars[a.name], a.type, `scalar ${a.name}`);
      }
      fail("VALIDATION", "Unknown argument kind");
    });
    for (const key of Object.keys(inputScalars))
      if (!scalarNames.has(key)) fail("VALIDATION", `Undeclared scalar ${key}`);
    const settings = {
      timeoutMs: integer(options.timeoutMs ?? 5000, 1, 60000, "timeoutMs"),
      instructionLimit: integer(
        options.instructionLimit ?? 1000000,
        1,
        HARD.instructions,
        "instructionLimit",
      ),
      traceLimit: integer(
        options.traceLimit ?? 10000,
        0,
        HARD.trace,
        "traceLimit",
      ),
      stackBytes: integer(
        options.stackBytes ?? 65536,
        PAGE,
        1024 * 1024,
        "stackBytes",
      ),
    };
    if (settings.stackBytes % PAGE)
      fail("VALIDATION", "stackBytes must be page aligned");
    return {
      regions,
      buffers,
      args,
      entry,
      returnType: contract.return,
      settings,
    };
  }
  async function execute(plan, factory) {
    const uc = await factory(),
      e = new uc.Unicorn(uc.ARCH_ARM64, uc.MODE_ARM),
      hooks = [],
      trace = [],
      stats = {
        instructions: 0,
        reads: 0,
        writes: 0,
        readBytes: 0,
        writeBytes: 0,
        imports: {},
        traceEvents: 0,
      };
    let fault = null;
    const started = performance.now();
    const stack = {
      address: STACK,
      size: plan.settings.stackBytes,
      kind: "stack",
      id: "stack",
      name: "stack",
      read: true,
      write: true,
      execute: false,
    };
    const regions = [...plan.regions, ...plan.buffers, stack];
    const locate = (address, size, access) => {
      if (
        !Number.isSafeInteger(address) ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        !Number.isSafeInteger(address + size)
      )
        fail("MEMORY_BOUNDS", "Invalid memory address/size", {
          address: String(address),
          size,
        });
      const r = regions.find(
        (r) =>
          address >= r.address &&
          address + size <=
            r.address + (access === "read" ? (r.readSize ?? r.size) : r.size),
      );
      if (!r || !r[access])
        fail(
          access === "execute" ? "EXECUTION_BOUNDS" : "MEMORY_BOUNDS",
          `Forbidden ${access} at 0x${address.toString(16)} (${size} bytes)`,
          {
            address,
            size,
            access,
            region:
              regions.find(
                (r) =>
                  address >= r.address &&
                  address < r.address + (r.mapped ?? r.size),
              )?.name ?? "unmapped",
          },
        );
      return r;
    };
    const record = (kind, address, size, r, model) => {
      stats.traceEvents++;
      if (!plan.settings.traceLimit) return;
      if (trace.length >= plan.settings.traceLimit)
        fail("TRACE_LIMIT", "Trace event budget exhausted", {
          limit: plan.settings.traceLimit,
        });
      trace.push({
        kind,
        address,
        size,
        region: r.name,
        regionId: r.id,
        regionKind: r.kind,
        offset: address - r.address,
        ...(model ? { model } : {}),
      });
    };
    const memory = (address, size, writing, model) => {
      const kind = writing ? "write" : "read",
        r = locate(address, size, kind);
      stats[writing ? "writes" : "reads"]++;
      stats[writing ? "writeBytes" : "readBytes"] += size;
      record(kind, address, size, r, model);
      return r;
    };
    const guarded =
      (fn) =>
      (...args) => {
        if (fault) return;
        try {
          return fn(...args);
        } catch (err) {
          fault = err;
          e.emu_stop();
        }
      };
    try {
      const pages = new Map();
      for (const r of plan.regions) {
        for (let j = 0; j < r.size; j++) {
          const address = r.address + j,
            page = Math.floor(address / PAGE) * PAGE;
          let p = pages.get(page);
          if (!p) {
            p = { data: new Uint8Array(PAGE), exec: false };
            pages.set(page, p);
          }
          p.data[address - page] = r.data[j];
          p.exec ||= r.execute;
        }
      }
      for (const [address, p] of pages) {
        e.mem_map(address, PAGE, uc.PROT_READ | (p.exec ? uc.PROT_EXEC : 0));
        e.mem_write(address, p.data);
      }
      for (const r of plan.buffers) {
        e.mem_map(
          r.address,
          r.mapped,
          (r.read ? uc.PROT_READ : 0) | (r.write ? uc.PROT_WRITE : 0),
        );
        if (r.data.length) e.mem_write(r.address, r.data);
      }
      e.mem_map(STACK, stack.size, uc.PROT_READ | uc.PROT_WRITE);
      e.mem_map(STOP, PAGE, uc.PROT_READ | uc.PROT_EXEC);
      e.reg_write_i64(uc.ARM64_REG_SP, BigInt(STACK + stack.size - 16));
      e.reg_write_i64(uc.ARM64_REG_LR, BigInt(STOP));
      e.reg_write_i64(uc.ARM64_REG_CPACR_EL1, 3n << 20n);
      for (let i = 0; i < plan.args.length; i++)
        e.reg_write_i64(uc[`ARM64_REG_X${i}`], plan.args[i]);
      hooks.push(
        e.hook_add(
          uc.HOOK_CODE,
          guarded((eng, raw, size) => {
            const pc = Number(raw);
            if (pc % 4 || size !== 4)
              fail("EXECUTION_BOUNDS", "Unaligned or invalid instruction", {
                address: pc,
                size,
              });
            const r = locate(pc, size, "execute");
            if (stats.instructions >= plan.settings.instructionLimit)
              fail("INSTRUCTION_LIMIT", "Instruction budget exhausted", {
                limit: plan.settings.instructionLimit,
              });
            stats.instructions++;
            record("instruction", pc, size, r);
            if (r.kind === "import") {
              const d = Number(
                  BigInt.asUintN(64, e.reg_read_i64(uc.ARM64_REG_X0)),
                ),
                sourceRaw = BigInt.asUintN(64, e.reg_read_i64(uc.ARM64_REG_X1)),
                s = Number(sourceRaw),
                n = Number(BigInt.asUintN(64, e.reg_read_i64(uc.ARM64_REG_X2)));
              if (!Number.isSafeInteger(n) || n < 0 || n > HARD.bufferBytes) {
                fail(
                  "MEMORY_BOUNDS",
                  "Import size exceeds the bounded model limit",
                  {
                    model: r.model,
                    address: d,
                    size: String(n),
                    limit: HARD.bufferBytes,
                  },
                );
              }
              if (n) {
                memory(d, n, true, r.model);
                let value;
                if (r.model === "memset") {
                  value = new Uint8Array(n).fill(
                    Number(BigInt.asUintN(8, sourceRaw)),
                  );
                } else {
                  memory(s, n, false, r.model);
                  if (r.model === "memcpy" && d < s + n && s < d + n)
                    fail("IMPORT_OVERLAP", "memcpy ranges overlap", {
                      destination: d,
                      source: s,
                      size: n,
                    });
                  value = e.mem_read(s, n);
                }
                e.mem_write(d, value);
              }
              stats.imports[r.model] = (stats.imports[r.model] || 0) + 1;
            }
          }),
        ),
      );
      hooks.push(
        e.hook_add(
          uc.HOOK_MEM_READ | uc.HOOK_MEM_WRITE,
          guarded((eng, type, address, size) =>
            memory(Number(address), size, type === uc.MEM_WRITE),
          ),
        ),
      );
      const invalid =
        uc.HOOK_MEM_READ_UNMAPPED |
        uc.HOOK_MEM_WRITE_UNMAPPED |
        uc.HOOK_MEM_FETCH_UNMAPPED |
        uc.HOOK_MEM_READ_PROT |
        uc.HOOK_MEM_WRITE_PROT |
        uc.HOOK_MEM_FETCH_PROT;
      hooks.push(
        e.hook_add(invalid, (eng, type, address, size) => {
          if (!fault)
            fault = new CapsuleError(
              "MEMORY_BOUNDS",
              "Unmapped or protected emulator access",
              { address: Number(address), size, type },
            );
          return false;
        }),
      );
      // This pinned backend aborts when its internal timeout thread is used. The host worker timer is authoritative.
      try {
        e.emu_start(plan.entry, STOP, 0, plan.settings.instructionLimit + 1);
      } catch (err) {
        if (!fault)
          fault = new CapsuleError(
            "EMULATOR_ERROR",
            String(err).slice(0, 1000),
            { pc: Number(e.reg_read_i64(uc.ARM64_REG_PC)) },
          );
      }
      if (fault) throw fault;
      if (Number(e.reg_read_i64(uc.ARM64_REG_PC)) !== STOP)
        fail(
          "INSTRUCTION_LIMIT",
          "Execution did not return within the instruction budget",
        );
      const raw = e.reg_read_i64(uc.ARM64_REG_X0),
        bits = plan.returnType.endsWith("64") ? 64 : 32,
        value =
          plan.returnType[0] === "i"
            ? BigInt.asIntN(bits, raw)
            : BigInt.asUintN(bits, raw);
      const outputs = {};
      for (const r of plan.buffers)
        if (r.write) outputs[r.name] = hex(e.mem_read(r.address, r.size));
      stats.wallMilliseconds = performance.now() - started;
      return {
        returnValue: bits === 64 ? value.toString() : Number(value),
        outputs,
        trace,
        stats,
      };
    } catch (err) {
      const failure =
        err instanceof CapsuleError
          ? err
          : new CapsuleError("EMULATOR_ERROR", String(err).slice(0, 1000));
      failure.details = { ...failure.details, trace, stats };
      throw failure;
    } finally {
      for (const h of hooks)
        try {
          e.hook_del(h);
        } catch {}
      try {
        e.close();
      } catch {}
    }
  }
  const api = { validate, execute, CapsuleError };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CapsulithCore = api;
})(typeof self === "object" ? self : globalThis);
