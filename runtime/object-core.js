/* SPDX-License-Identifier: GPL-2.0-only */
(function (root) {
  "use strict";
  const node = typeof module === "object" && module.exports;
  const crypto = node ? require("node:crypto").webcrypto : root.crypto;
  const { validate, CapsuleError } = node
    ? require("./core.js")
    : root.CapsulithCore;
  const PAGE = 4096,
    BASE = 0x1000000,
    START = 0x4000000,
    STACK = 0x20000000,
    STOP = 0x30000000;
  const MODEL = "capsulith.memory.v1",
    TYPES = ["reference", "i32", "u32", "i64", "u64"],
    IMPORTS = ["malloc", "bzero", "free", "memcpy", "memmove", "memset"];
  const HARD = {
    bytes: 16 * 1024 * 1024,
    heap: 8 * 1024 * 1024,
    allocations: 1024,
    buffers: 64,
    calls: 10000,
    instructions: 100000000,
    entries: 32,
  };
  const fail = (code, message, details = {}) => {
    throw new CapsuleError(code, message, details);
  };
  const obj = (v, label) => {
    if (!v || typeof v !== "object" || Array.isArray(v))
      fail("VALIDATION", `${label} must be an object`);
    return v;
  };
  const int = (v, min, max, label) => {
    if (!Number.isSafeInteger(v) || v < min || v > max)
      fail("VALIDATION", `${label} must be an integer in [${min}, ${max}]`);
    return v;
  };
  const validName = (n, label) => {
    if (
      typeof n !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(n) ||
      ["__proto__", "constructor", "prototype"].includes(n)
    )
      fail("VALIDATION", `${label} is invalid`);
    return n;
  };
  const canonical = (v) => JSON.stringify(sort(v));
  function sort(v) {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
      return out;
    }
    return v;
  }
  async function digest(v) {
    if (!crypto?.subtle || typeof crypto.randomUUID !== "function") {
      fail(
        "CRYPTO_UNAVAILABLE",
        "Native objects require built-in WebCrypto in a secure context",
      );
    }
    const data = new TextEncoder().encode(canonical(v));
    return tohex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
  }
  function identity(m) {
    return {
      schema: m.schema,
      architecture: m.architecture,
      artifactSHA256: m.artifactSHA256,
      modelVersion: m.modelVersion,
      chunks: m.chunks,
      imports: m.imports,
      entries: m.entries,
    };
  }
  function unhex(s, max, label) {
    if (
      typeof s !== "string" ||
      s.length > max * 2 ||
      s.length % 2 ||
      !/^[0-9a-fA-F]*$/.test(s)
    )
      fail("VALIDATION", `${label} must be bounded exact hexadecimal`);
    // Keep admission identical, then use the native conversion for large Node snapshots.
    if (node) return new Uint8Array(Buffer.from(s, "hex"));
    const bytes = new Uint8Array(s.length / 2);
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  const HEX = Array.from({ length: 256 }, (_, i) =>
    i.toString(16).padStart(2, "0"),
  );
  function tohex(b) {
    if (node) return Buffer.from(b).toString("hex");
    let out = "";
    for (let start = 0; start < b.length; start += 32768) {
      const stop = Math.min(start + 32768, b.length),
        chunk = new Array(stop - start);
      for (let i = start; i < stop; i++) chunk[i - start] = HEX[b[i]];
      out += chunk.join("");
    }
    return out;
  }
  function scalar(v, type) {
    if (type.endsWith("64")) {
      if (
        typeof v !== "string" ||
        v.length > 21 ||
        !/^-?(0|[1-9][0-9]*)$/.test(v)
      )
        fail("VALIDATION", "64-bit integers require decimal strings");
    } else
      int(
        v,
        type === "i32" ? -2147483648 : 0,
        type === "i32" ? 2147483647 : 4294967295,
        "integer argument",
      );
    const n = BigInt(v),
      bits = type.endsWith("64") ? 64 : 32;
    if (
      (type[0] === "i" ? BigInt.asIntN(bits, n) : BigInt.asUintN(bits, n)) !== n
    )
      fail("VALIDATION", "Integer argument is out of range");
    return n;
  }
  function baseSettings(options = {}) {
    obj(options, "options");
    const limits =
      options.limits === undefined ? options : obj(options.limits, "limits");
    return {
      timeoutMs: int(limits.timeoutMs ?? 5000, 1, 60000, "timeoutMs"),
      instructionLimit: int(
        limits.instructionLimit ?? 1000000,
        1,
        10000000,
        "instructionLimit",
      ),
      traceLimit: int(limits.traceLimit ?? 10000, 0, 200000, "traceLimit"),
      stackBytes: int(limits.stackBytes ?? 65536, PAGE, 1048576, "stackBytes"),
      maxHeapBytes: int(
        limits.maxHeapBytes ?? HARD.heap,
        1,
        HARD.heap,
        "maxHeapBytes",
      ),
      maxBufferBytes: int(
        limits.maxBufferBytes ?? HARD.bytes,
        1,
        HARD.bytes,
        "maxBufferBytes",
      ),
      maxTotalBytes: int(
        limits.maxTotalBytes ?? HARD.bytes,
        1,
        HARD.bytes,
        "maxTotalBytes",
      ),
      maxAllocations: int(
        limits.maxAllocations ?? 1024,
        1,
        HARD.allocations,
        "maxAllocations",
      ),
      maxBuffers: int(limits.maxBuffers ?? 64, 1, HARD.buffers, "maxBuffers"),
      callLimit: int(limits.callLimit ?? 1000, 1, HARD.calls, "callLimit"),
      totalInstructionLimit: int(
        limits.totalInstructionLimit ?? 20000000,
        1,
        HARD.instructions,
        "totalInstructionLimit",
      ),
    };
  }
  const LIMIT_KEYS = Object.freeze(Object.keys(baseSettings()));
  function capturedLimits(checkpoint) {
    obj(checkpoint, "checkpoint");
    if (!Object.hasOwn(checkpoint, "limits")) {
      fail(
        "CHECKPOINT_LIMITS",
        "Unreleased checkpoint lacks captured limits; regenerate it from the original instance",
      );
    }
    const value = obj(checkpoint.limits, "captured limits");
    if (
      Object.keys(value).length !== LIMIT_KEYS.length ||
      LIMIT_KEYS.some((k) => !Object.hasOwn(value, k)) ||
      Object.keys(value).some((k) => !LIMIT_KEYS.includes(k))
    ) {
      fail(
        "CHECKPOINT_LIMITS",
        "Checkpoint must contain every configured limit exactly once",
      );
    }
    const validated = baseSettings({ limits: value });
    if (validated.stackBytes % PAGE)
      fail("CHECKPOINT_LIMITS", "Captured stack size must be page aligned");
    return validated;
  }
  function settings(options = {}) {
    obj(options, "options");
    const explicit =
      options.limits === undefined ? options : obj(options.limits, "limits");
    if (
      options.limits !== undefined &&
      Object.keys(explicit).some((k) => !LIMIT_KEYS.includes(k))
    ) {
      fail("VALIDATION", "Unknown configured limit");
    }
    if (options.checkpoint === undefined)
      return Object.freeze(baseSettings(options));
    const captured = capturedLimits(options.checkpoint);
    const merged = { ...captured };
    for (const k of LIMIT_KEYS) {
      if (!Object.hasOwn(explicit, k)) continue;
      // Explicit values must validate as values, never fall back to defaults.
      if (explicit[k] === undefined || explicit[k] === null)
        fail("VALIDATION", `${k} must be an explicit integer limit`);
      merged[k] = explicit[k];
    }
    const validated = baseSettings({ limits: merged });
    if (validated.stackBytes % PAGE)
      fail("VALIDATION", "stackBytes must be page aligned");
    for (const k of LIMIT_KEYS)
      if (validated[k] > captured[k]) {
        fail("LIMIT_INCREASE", `Restore cannot increase captured ${k}`, {
          limit: k,
          captured: captured[k],
          requested: validated[k],
        });
      }
    return Object.freeze(validated);
  }
  async function validateModule(m, options = {}) {
    obj(m, "module");
    obj(options, "options");
    if (
      m.schema !== "capsulith.module.v1" ||
      m.architecture !== "arm64" ||
      m.modelVersion !== MODEL
    )
      fail("VALIDATION", "Unsupported module architecture/schema/model");
    obj(m.entries, "entries");
    const entries = Object.entries(m.entries);
    if (!entries.length || entries.length > HARD.entries)
      fail("VALIDATION", "Module must have one to 32 entries");
    for (const [n, e] of entries) {
      validName(n, "entry name");
      obj(e, "entry");
      if (typeof e.root !== "string" || e.root.length > 256)
        fail("VALIDATION", "Invalid original root");
      if (
        !Array.isArray(e.args) ||
        e.args.length > 8 ||
        e.args.some((t) => !TYPES.includes(t)) ||
        !TYPES.includes(e.return)
      )
        fail("VALIDATION", "Invalid entry signature");
    }
    if (!Array.isArray(m.imports) || m.imports.length > 1024)
      fail("VALIDATION", "Invalid import count");
    for (const i of m.imports) {
      obj(i, "import");
      if (typeof i.name !== "string")
        fail("UNSUPPORTED_IMPORT", "Invalid import name");
    }
    const ordinary = m.imports.filter((i) =>
      ["memcpy", "memmove", "memset"].includes(i?.name?.replace(/^_/, "")),
    );
    const plan = validate(
      {
        ...m,
        schema: 1,
        entry: entries[0][1].entry,
        imports: ordinary,
        contract: {
          buffers: [],
          args: [],
          return: "i32",
          imports: [...new Set(ordinary.map((i) => i.name.replace(/^_/, "")))],
        },
      },
      {},
      options.limits ?? options,
    );
    for (const i of m.imports) {
      obj(i, "import");
      if (
        typeof i.name !== "string" ||
        !/^_?(malloc|bzero|free|memcpy|memmove|memset)$/.test(i.name)
      )
        fail(
          "UNSUPPORTED_IMPORT",
          "Only declared bounded object-memory imports are supported",
        );
      int(i.address, 0, 0x1000000 - 4, "import address");
      if (i.address % 4) fail("VALIDATION", "Import address is not aligned");
      if (!ordinary.includes(i))
        plan.regions.push({
          address: BASE + i.address,
          size: 4,
          data: Uint8Array.from([0xc0, 0x03, 0x5f, 0xd6]),
          kind: "import",
          name: i.name,
          id: `import:${i.address}`,
          model: i.name.replace(/^_/, ""),
          read: true,
          write: false,
          execute: true,
        });
    }
    for (const r of plan.regions)
      if (r.kind === "import") r.model = r.name.replace(/^_/, "");
    plan.regions.sort((a, b) => a.address - b.address);
    for (let i = 1; i < plan.regions.length; i++)
      if (
        plan.regions[i].address <
        plan.regions[i - 1].address + plan.regions[i - 1].size
      )
        fail("VALIDATION", "Module ranges overlap");
    for (const [, e] of entries) {
      int(e.entry, 0, 0x1000000 - 4, "entry address");
      if (
        e.entry % 4 ||
        !plan.regions.some(
          (r) =>
            r.kind === "code" &&
            BASE + e.entry >= r.address &&
            BASE + e.entry + 4 <= r.address + r.size,
        )
      )
        fail("VALIDATION", "Named entry is outside aligned logical code");
    }
    const limits = settings(options);
    if (limits.stackBytes % PAGE)
      fail("VALIDATION", "stackBytes must be page aligned");
    if (
      typeof m.id !== "string" ||
      !/^[a-f0-9]{64}$/.test(m.id) ||
      (await digest(identity(m))) !== m.id
    )
      fail(
        "MODULE_ID",
        "Module identity does not match its code/contracts/models",
      );
    return { module: m, regions: plan.regions, limits };
  }
  class ObjectEngine {
    static async create(module, options, factory) {
      const plan = await validateModule(module, options),
        uc = await factory();
      const engine = new ObjectEngine(plan, uc);
      try {
        // Bind the snapshot and captured ceilings before mapping code or guest state.
        if (options.checkpoint !== undefined)
          await engine.restore(options.checkpoint);
        engine.mapCode();
        return engine;
      } catch (err) {
        engine.close();
        throw err;
      }
    }
    constructor(plan, uc) {
      this.module = plan.module;
      this.code = plan.regions;
      this.limits = plan.limits;
      this.uc = uc;
      this.e = new uc.Unicorn(uc.ARCH_ARM64, uc.MODE_ARM);
      this.instanceId = crypto.randomUUID();
      this.regions = new Map();
      this.nextAddress = START;
      this.nextId = 1;
      this.allocations = 0;
      this.bufferCount = 0;
      this.bufferAllocations = 0;
      this.heapBytes = 0;
      this.bufferBytes = 0;
      this.calls = 0;
      this.totalInstructions = 0;
      this.poisoned = false;
      this.closed = false;
      this.hooks = [];
      this.active = null;
    }
    assertLive() {
      if (this.closed) fail("CLOSED", "Module instance is closed");
      if (this.poisoned)
        fail(
          "POISONED",
          "Module instance failed; restore a prior checkpoint into a fresh instance",
        );
    }
    mapCode() {
      const pages = new Map();
      for (const r of this.code) {
        for (let j = 0; j < r.size; j++) {
          const a = r.address + j,
            p = Math.floor(a / PAGE) * PAGE;
          let page = pages.get(p);
          if (!page) {
            page = { data: new Uint8Array(PAGE), exec: false };
            pages.set(p, page);
          }
          page.data[a - p] = r.data[j];
          page.exec ||= r.execute;
        }
      }
      for (const [a, p] of pages) {
        this.e.mem_map(
          a,
          PAGE,
          this.uc.PROT_READ | (p.exec ? this.uc.PROT_EXEC : 0),
        );
        this.e.mem_write(a, p.data);
      }
      this.e.mem_map(
        STACK,
        this.limits.stackBytes,
        this.uc.PROT_READ | this.uc.PROT_WRITE,
      );
      this.e.mem_map(STOP, PAGE, this.uc.PROT_READ | this.uc.PROT_EXEC);
    }
    reference(regionId, offset = 0) {
      this.assertLive();
      const r = this.regions.get(regionId);
      if (!r || !r.live)
        fail("REFERENCE", "Reference does not identify a live owned region");
      int(offset, 0, r.capacity, "reference offset");
      return { instanceId: this.instanceId, regionId: r.id, offset };
    }
    resolve(ref) {
      if (ref === null) return { address: 0, region: null };
      obj(ref, "reference");
      if (ref.instanceId !== this.instanceId)
        fail("REFERENCE", "Foreign instance reference");
      const r = this.regions.get(ref.regionId);
      if (!r || !r.live) fail("REFERENCE", "Freed or unknown region reference");
      int(ref.offset, 0, r.capacity, "reference offset");
      return { address: r.address + ref.offset, region: r };
    }
    pointer(address) {
      if (address === 0) return null;
      if (!Number.isSafeInteger(address))
        fail("REFERENCE", "Returned pointer is not an exact guest address");
      const r = [...this.regions.values()].find(
        (r) =>
          r.live && address >= r.address && address <= r.address + r.capacity,
      );
      if (!r)
        fail("REFERENCE", "Returned pointer is outside live owned regions", {
          address,
        });
      return this.reference(r.id, address - r.address);
    }
    addRegion({
      kind,
      name,
      access,
      capacity,
      data,
      id,
      address,
      initialized,
    }) {
      const mapped = Math.max(PAGE, Math.ceil(capacity / PAGE) * PAGE),
        a = address ?? this.nextAddress;
      int(a, START, STACK - PAGE, "region address");
      if (a % PAGE || a + mapped + PAGE > STACK)
        fail("MEMORY_LIMIT", "Owned address space exhausted");
      if (
        [...this.regions.values()].some(
          (r) => r.live && a < r.address + r.mapped && r.address < a + mapped,
        )
      )
        fail("VALIDATION", "Owned region ranges overlap");
      const r = {
        id: id ?? `region${this.nextId++}`,
        kind,
        name,
        access,
        capacity,
        address: a,
        mapped,
        live: true,
        initialized:
          kind === "heap" ? (initialized ?? new Uint8Array(capacity)) : null,
      };
      if (this.regions.has(r.id))
        fail("VALIDATION", "Duplicate region identity");
      this.e.mem_map(
        a,
        mapped,
        (access === "write" ? 0 : this.uc.PROT_READ) |
          (access === "read" ? 0 : this.uc.PROT_WRITE),
      );
      if (data?.length) this.e.mem_write(a, data);
      this.regions.set(r.id, r);
      this.nextAddress = Math.max(this.nextAddress, a + mapped + PAGE);
      if (kind === "heap") this.heapBytes += capacity;
      else {
        this.bufferBytes += capacity;
        this.bufferCount++;
      }
      return r;
    }
    allocateBuffer(spec) {
      this.assertLive();
      obj(spec, "buffer");
      validName(spec.name, "buffer name");
      if (
        [...this.regions.values()].some(
          (r) => r.live && r.kind === "buffer" && r.name === spec.name,
        )
      )
        fail("VALIDATION", "Duplicate buffer name");
      if (!["read", "write", "readwrite"].includes(spec.access))
        fail("VALIDATION", "Invalid buffer access");
      int(spec.capacity, 0, this.limits.maxBufferBytes, "buffer capacity");
      const data = unhex(spec.bytes ?? "", spec.capacity, "buffer bytes");
      if (
        this.bufferAllocations >= this.limits.maxBuffers ||
        this.bufferBytes + spec.capacity > this.limits.maxBufferBytes ||
        this.heapBytes + this.bufferBytes + spec.capacity >
          this.limits.maxTotalBytes
      )
        fail("MEMORY_LIMIT", "Caller buffer budget exceeded");
      const initial = new Uint8Array(spec.capacity);
      initial.set(data);
      const r = this.addRegion({
        kind: "buffer",
        name: spec.name,
        access: spec.access,
        capacity: spec.capacity,
        data: initial,
      });
      r.readSize = spec.access === "read" ? data.length : spec.capacity;
      this.bufferAllocations++;
      return this.reference(r.id);
    }
    releaseBuffer(ref) {
      this.assertLive();
      const { region: r } = this.resolve(ref);
      if (!r || r.kind !== "buffer" || ref.offset !== 0)
        fail("REFERENCE", "Release requires a caller buffer base reference");
      this.retire(r);
      return null;
    }
    retire(r) {
      this.e.mem_unmap(r.address, r.mapped);
      r.live = false;
      if (r.kind === "heap") this.heapBytes -= r.capacity;
      else {
        this.bufferBytes -= r.capacity;
        this.bufferCount--;
      }
    }
    locate(address, size, access) {
      if (
        !Number.isSafeInteger(address) ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        !Number.isSafeInteger(address + size)
      )
        fail("MEMORY_BOUNDS", "Inexact memory address/size", {
          address: String(address),
          size,
        });
      let r = this.code.find(
        (r) => address >= r.address && address + size <= r.address + r.size,
      );
      if (r) {
        if (!r[access])
          fail("MEMORY_BOUNDS", `Forbidden ${access} of ${r.kind}`, {
            address,
            size,
            region: r.name,
          });
        return r;
      }
      if (
        address >= STACK &&
        address + size <= STACK + this.limits.stackBytes
      ) {
        if (access === "execute")
          fail("EXECUTION_BOUNDS", "Stack is not executable", {
            address,
            size,
          });
        return {
          address: STACK,
          name: "stack",
          id: "stack",
          kind: "stack",
          size: this.limits.stackBytes,
        };
      }
      r = [...this.regions.values()].find(
        (r) =>
          r.live &&
          address >= r.address &&
          address + size <=
            r.address +
              (access === "read" ? (r.readSize ?? r.capacity) : r.capacity),
      );
      if (
        !r ||
        access === "execute" ||
        (access === "read" && r.access === "write") ||
        (access === "write" && r.access === "read")
      )
        fail(
          access === "execute" ? "EXECUTION_BOUNDS" : "MEMORY_BOUNDS",
          `Forbidden ${access} at 0x${address.toString(16)}`,
          { address, size, access },
        );
      if (access === "read" && r.initialized) {
        const start = address - r.address;
        for (let j = start; j < start + size; j++)
          if (!r.initialized[j])
            fail(
              "UNINITIALIZED_READ",
              "Native read accesses uninitialized heap bytes",
              { address: j + r.address, size: 1, region: r.id },
            );
      }
      return r;
    }
    record(kind, address, size, r, model) {
      const a = this.active;
      if (!a) return;
      a.stats.traceEvents++;
      if (!a.traceLimit) return;
      if (a.trace.length >= a.traceLimit)
        fail("TRACE_LIMIT", "Trace budget exhausted", { limit: a.traceLimit });
      a.trace.push({
        kind,
        address,
        size,
        region: r.name,
        regionId: r.id,
        regionKind: r.kind,
        offset: address - r.address,
        ...(model ? { model } : {}),
      });
    }
    memory(address, size, write, model) {
      const r = this.locate(address, size, write ? "write" : "read");
      if (this.active) {
        const s = this.active.stats;
        s[write ? "writes" : "reads"]++;
        s[write ? "writeBytes" : "readBytes"] += size;
        const evidence = (s.regions[r.id] ??= {
          name: r.name,
          kind: r.kind,
          address: r.address,
          reads: 0,
          writes: 0,
          readBytes: 0,
          writeBytes: 0,
        });
        evidence[write ? "writes" : "reads"]++;
        evidence[write ? "writeBytes" : "readBytes"] += size;
        if (size) {
          const key = write ? "write" : "read";
          evidence[key + "Min"] = Math.min(
            evidence[key + "Min"] ?? address,
            address,
          );
          evidence[key + "Max"] = Math.max(
            evidence[key + "Max"] ?? address + size,
            address + size,
          );
        }
      }
      this.record(write ? "write" : "read", address, size, r, model);
      if (write && r.initialized)
        r.initialized.fill(1, address - r.address, address - r.address + size);
      return r;
    }
    allocateHeap(size) {
      int(size, 0, this.limits.maxHeapBytes, "malloc size");
      if (
        this.allocations >= this.limits.maxAllocations ||
        this.heapBytes + size > this.limits.maxHeapBytes ||
        this.heapBytes + this.bufferBytes + size > this.limits.maxTotalBytes
      )
        fail("MEMORY_LIMIT", "Native allocation budget exhausted");
      const r = this.addRegion({
        kind: "heap",
        name: `heap${this.allocations + 1}`,
        access: "readwrite",
        capacity: size,
        data: new Uint8Array(size).fill(0xa5),
      });
      this.allocations++;
      this.active.stats.allocations.push({
        regionId: r.id,
        address: r.address,
        size,
        initializedBytes: 0,
      });
      this.record("allocation", r.address, size, r, "malloc");
      return r.address;
    }
    importModel(model) {
      const reg = (i) =>
          BigInt.asUintN(64, this.e.reg_read_i64(this.uc[`ARM64_REG_X${i}`])),
        a = Number(reg(0)),
        b = Number(reg(1)),
        c = Number(reg(2));
      if (model === "malloc") {
        if (!Number.isSafeInteger(a) || a > this.limits.maxHeapBytes)
          fail("MEMORY_LIMIT", "malloc request exceeds bounded heap", {
            size: String(reg(0)),
          });
        this.e.reg_write_i64(
          this.uc.ARM64_REG_X0,
          BigInt(this.allocateHeap(a)),
        );
      } else if (model === "free") {
        if (a !== 0) {
          const r = [...this.regions.values()].find(
            (r) => r.live && r.kind === "heap" && r.address === a,
          );
          if (!r)
            fail("REFERENCE", "free requires a live native allocation base", {
              address: a,
            });
          this.record("free", a, r.capacity, r, model);
          this.retire(r);
          this.active.stats.frees++;
        }
      } else {
        const n = model === "bzero" ? b : c;
        if (!Number.isSafeInteger(n) || n < 0 || n > HARD.bytes)
          fail("MEMORY_BOUNDS", "Imported memory operation exceeds bounds", {
            model,
            size: String(n),
          });
        if (n) {
          this.locate(a, n, "write");
          let data;
          if (model === "bzero" || model === "memset")
            data = new Uint8Array(n).fill(
              model === "bzero" ? 0 : Number(BigInt.asUintN(8, reg(1))),
            );
          else {
            this.memory(b, n, false, model);
            if (model === "memcpy" && a < b + n && b < a + n)
              fail("IMPORT_OVERLAP", "memcpy regions overlap");
            data = this.e.mem_read(b, n);
          }
          this.memory(a, n, true, model);
          this.e.mem_write(a, data);
        }
      }
      this.active.stats.imports[model] =
        (this.active.stats.imports[model] || 0) + 1;
    }
    call(name, args = [], overrides = {}) {
      this.assertLive();
      validName(name, "method name");
      if (!Object.hasOwn(this.module.entries, name))
        fail("VALIDATION", "Unknown named method");
      const entry = this.module.entries[name];
      if (!Array.isArray(args) || args.length !== entry.args.length)
        fail("VALIDATION", "Argument count does not match declared signature");
      const values = args.map((v, i) =>
        entry.args[i] === "reference"
          ? BigInt(this.resolve(v).address)
          : scalar(v, entry.args[i]),
      );
      obj(overrides, "call limits");
      const instructionLimit = int(
          overrides.instructionLimit ?? this.limits.instructionLimit,
          1,
          this.limits.instructionLimit,
          "instructionLimit",
        ),
        traceLimit = int(
          overrides.traceLimit ?? this.limits.traceLimit,
          0,
          this.limits.traceLimit,
          "traceLimit",
        );
      if (
        this.calls >= this.limits.callLimit ||
        this.totalInstructions >= this.limits.totalInstructionLimit
      ) {
        this.poisoned = true;
        fail("INSTRUCTION_LIMIT", "Module lifetime budget exhausted");
      }
      this.calls++;
      const active = {
        instructionLimit,
        traceLimit,
        trace: [],
        stats: {
          instructions: 0,
          reads: 0,
          writes: 0,
          readBytes: 0,
          writeBytes: 0,
          traceEvents: 0,
          regions: {},
          imports: {},
          allocations: [],
          frees: 0,
        },
        fault: null,
      };
      this.active = active;
      const began = performance.now();
      const guard =
        (fn) =>
        (...args) => {
          if (active.fault) return;
          try {
            return fn(...args);
          } catch (err) {
            active.fault = err;
            this.e.emu_stop();
          }
        };
      try {
        for (let i = 0; i < 31; i++)
          this.e.reg_write_i64(this.uc[`ARM64_REG_X${i}`], 0n);
        this.e.reg_write_i64(
          this.uc.ARM64_REG_SP,
          BigInt(STACK + this.limits.stackBytes - 16),
        );
        this.e.reg_write_i64(this.uc.ARM64_REG_LR, BigInt(STOP));
        this.e.reg_write_i64(this.uc.ARM64_REG_CPACR_EL1, 3n << 20n);
        for (let i = 0; i < values.length; i++)
          this.e.reg_write_i64(this.uc[`ARM64_REG_X${i}`], values[i]);
        this.hooks.push(
          this.e.hook_add(
            this.uc.HOOK_CODE,
            guard((eng, raw, size) => {
              const pc = Number(raw);
              if (pc % 4 || size !== 4)
                fail("EXECUTION_BOUNDS", "Invalid instruction alignment", {
                  address: pc,
                  size,
                });
              const r = this.locate(pc, size, "execute");
              if (
                active.stats.instructions >= instructionLimit ||
                this.totalInstructions >= this.limits.totalInstructionLimit
              )
                fail("INSTRUCTION_LIMIT", "Instruction budget exhausted");
              active.stats.instructions++;
              this.totalInstructions++;
              this.record("instruction", pc, size, r);
              if (r.kind === "import") this.importModel(r.model);
            }),
          ),
        );
        this.hooks.push(
          this.e.hook_add(
            this.uc.HOOK_MEM_READ | this.uc.HOOK_MEM_WRITE,
            guard((eng, type, address, size) =>
              this.memory(Number(address), size, type === this.uc.MEM_WRITE),
            ),
          ),
        );
        const invalid =
          this.uc.HOOK_MEM_READ_UNMAPPED |
          this.uc.HOOK_MEM_WRITE_UNMAPPED |
          this.uc.HOOK_MEM_FETCH_UNMAPPED |
          this.uc.HOOK_MEM_READ_PROT |
          this.uc.HOOK_MEM_WRITE_PROT |
          this.uc.HOOK_MEM_FETCH_PROT;
        this.hooks.push(
          this.e.hook_add(invalid, (eng, type, address, size) => {
            if (!active.fault)
              active.fault = new CapsuleError(
                "MEMORY_BOUNDS",
                "Unmapped or protected object memory",
                { address: Number(address), size, type },
              );
            return false;
          }),
        );
        try {
          this.e.emu_start(BASE + entry.entry, STOP, 0, instructionLimit + 1);
        } catch (err) {
          if (!active.fault)
            active.fault = new CapsuleError(
              "EMULATOR_ERROR",
              String(err).slice(0, 1000),
            );
        }
        if (active.fault) throw active.fault;
        if (Number(this.e.reg_read_i64(this.uc.ARM64_REG_PC)) !== STOP)
          fail("INSTRUCTION_LIMIT", "Native operation did not return");
        const raw = this.e.reg_read_i64(this.uc.ARM64_REG_X0);
        let returnValue;
        if (entry.return === "reference")
          returnValue = this.pointer(Number(BigInt.asUintN(64, raw)));
        else {
          const bits = entry.return.endsWith("64") ? 64 : 32,
            n =
              entry.return[0] === "i"
                ? BigInt.asIntN(bits, raw)
                : BigInt.asUintN(bits, raw);
          returnValue = bits === 64 ? n.toString() : Number(n);
        }
        const outputs = {};
        for (const r of this.regions.values())
          if (r.live && r.kind === "buffer" && r.access !== "read")
            outputs[r.name] = tohex(this.e.mem_read(r.address, r.capacity));
        active.stats.wallMilliseconds = performance.now() - began;
        active.stats.totalInstructions = this.totalInstructions;
        return {
          returnValue,
          outputs,
          trace: active.trace,
          stats: active.stats,
        };
      } catch (err) {
        this.poisoned = true;
        const failure =
          err instanceof CapsuleError
            ? err
            : new CapsuleError("EMULATOR_ERROR", String(err).slice(0, 1000));
        failure.details = {
          ...failure.details,
          trace: active.trace,
          stats: active.stats,
        };
        throw failure;
      } finally {
        for (const h of this.hooks)
          try {
            this.e.hook_del(h);
          } catch {}
        this.hooks = [];
        this.active = null;
      }
    }
    readBuffer(ref, length) {
      this.assertLive();
      const { address, region: r } = this.resolve(ref);
      if (!r) fail("REFERENCE", "Cannot read null");
      const n = int(
        length ?? r.capacity - ref.offset,
        0,
        r.capacity - ref.offset,
        "read length",
      );
      this.locate(address, n, "read");
      return tohex(this.e.mem_read(address, n));
    }
    async checkpoint() {
      this.assertLive();
      const regions = [...this.regions.values()]
        .filter((r) => r.live)
        .map((r) => ({
          id: r.id,
          kind: r.kind,
          name: r.name,
          address: r.address,
          capacity: r.capacity,
          access: r.access,
          readSize: r.readSize ?? r.capacity,
          bytes: tohex(this.e.mem_read(r.address, r.capacity)),
          ...(r.initialized ? { initialized: tohex(r.initialized) } : {}),
        }));
      const cp = {
        schema: "capsulith.checkpoint.v1",
        moduleId: this.module.id,
        modelVersion: MODEL,
        originInstanceId: this.instanceId,
        limits: { ...this.limits },
        regions,
        nextAddress: this.nextAddress,
        nextId: this.nextId,
        allocations: this.allocations,
        bufferAllocations: this.bufferAllocations,
        calls: this.calls,
        totalInstructions: this.totalInstructions,
      };
      return { ...cp, digest: await digest(cp) };
    }
    async restore(cp) {
      obj(cp, "checkpoint");
      if (
        cp.schema !== "capsulith.checkpoint.v1" ||
        cp.moduleId !== this.module.id ||
        cp.modelVersion !== MODEL
      )
        fail("CHECKPOINT_ID", "Checkpoint code/model identity mismatch");
      const captured = capturedLimits(cp);
      for (const k of LIMIT_KEYS)
        if (this.limits[k] > captured[k]) {
          fail("LIMIT_INCREASE", `Restore cannot increase captured ${k}`);
        }
      if (
        !Array.isArray(cp.regions) ||
        cp.regions.length > HARD.allocations + HARD.buffers
      )
        fail("VALIDATION", "Checkpoint region count is invalid");
      const allowed = new Set([
        "schema",
        "moduleId",
        "modelVersion",
        "originInstanceId",
        "limits",
        "regions",
        "nextAddress",
        "nextId",
        "allocations",
        "bufferAllocations",
        "calls",
        "totalInstructions",
        "digest",
      ]);
      if (
        Object.keys(cp).some((k) => !allowed.has(k)) ||
        typeof cp.originInstanceId !== "string" ||
        cp.originInstanceId.length > 64
      ) {
        fail(
          "VALIDATION",
          "Checkpoint has unknown fields or invalid provenance",
        );
      }
      let byteTotal = 0;
      const callerNames = new Set();
      for (const spec of cp.regions) {
        obj(spec, "checkpoint region");
        const fields = new Set([
          "id",
          "kind",
          "name",
          "address",
          "capacity",
          "access",
          "readSize",
          "bytes",
          "initialized",
        ]);
        if (Object.keys(spec).some((k) => !fields.has(k)))
          fail("VALIDATION", "Unknown checkpoint region field");
        int(spec.capacity, 0, HARD.bytes, "region capacity");
        byteTotal += spec.capacity;
        if (
          byteTotal > this.limits.maxTotalBytes ||
          typeof spec.bytes !== "string" ||
          spec.bytes.length !== spec.capacity * 2 ||
          (spec.initialized !== undefined &&
            (typeof spec.initialized !== "string" ||
              spec.initialized.length !== spec.capacity * 2))
        ) {
          fail(
            "MEMORY_LIMIT",
            "Checkpoint byte lengths exceed bounded capacities",
          );
        }
        validName(spec.id, "region id");
        validName(spec.name, "region name");
        if (spec.kind === "buffer") {
          if (callerNames.has(spec.name))
            fail("VALIDATION", "Duplicate caller buffer name in checkpoint");
          callerNames.add(spec.name);
        }
        if (
          !["heap", "buffer"].includes(spec.kind) ||
          !["read", "write", "readwrite"].includes(spec.access)
        )
          fail("VALIDATION", "Invalid checkpoint region metadata");
        int(spec.address, START, STACK - PAGE, "region address");
        int(spec.readSize, 0, spec.capacity, "readSize");
      }
      int(cp.nextAddress, START, STACK - PAGE, "checkpoint nextAddress");
      int(
        cp.nextId,
        1,
        HARD.allocations + HARD.buffers + HARD.calls + 1,
        "checkpoint nextId",
      );
      int(
        cp.allocations,
        0,
        this.limits.maxAllocations,
        "checkpoint allocations",
      );
      int(
        cp.bufferAllocations,
        0,
        this.limits.maxBuffers,
        "checkpoint buffer allocations",
      );
      int(cp.calls, 0, this.limits.callLimit, "checkpoint calls");
      int(
        cp.totalInstructions,
        0,
        this.limits.totalInstructionLimit,
        "checkpoint instructions",
      );
      const { digest: hash, ...payload } = cp;
      if (typeof hash !== "string" || (await digest(payload)) !== hash)
        fail("CHECKPOINT_ID", "Checkpoint integrity digest mismatch");
      for (const spec of cp.regions) {
        obj(spec, "checkpoint region");
        validName(spec.id, "region id");
        validName(spec.name, "region name");
        if (
          !["heap", "buffer"].includes(spec.kind) ||
          !["read", "write", "readwrite"].includes(spec.access) ||
          (spec.kind === "heap" && spec.access !== "readwrite")
        )
          fail("VALIDATION", "Checkpoint kind/access is invalid");
        int(spec.capacity, 0, HARD.bytes, "region capacity");
        int(spec.readSize, 0, spec.capacity, "region readSize");
        const data = unhex(spec.bytes, spec.capacity, "region bytes");
        if (data.length !== spec.capacity)
          fail("VALIDATION", "Checkpoint bytes do not match capacity");
        let initialized;
        if (spec.kind === "heap") {
          initialized = unhex(
            spec.initialized,
            spec.capacity,
            "initialized bitmap",
          );
          if (
            initialized.length !== spec.capacity ||
            initialized.some((b) => b !== 0 && b !== 1)
          )
            fail("VALIDATION", "Invalid initialized-byte bitmap");
        } else if (spec.initialized !== undefined)
          fail(
            "VALIDATION",
            "Caller buffers cannot carry heap initialization state",
          );
        if (
          this.heapBytes + this.bufferBytes + spec.capacity >
            this.limits.maxTotalBytes ||
          (spec.kind === "heap"
            ? this.heapBytes + spec.capacity > this.limits.maxHeapBytes
            : this.bufferBytes + spec.capacity > this.limits.maxBufferBytes)
        )
          fail("MEMORY_LIMIT", "Checkpoint exceeds current memory limits");
        if (
          spec.kind === "buffer" &&
          this.bufferCount >= this.limits.maxBuffers
        )
          fail("MEMORY_LIMIT", "Checkpoint has excess caller buffers");
        const r = this.addRegion({ ...spec, data, initialized });
        r.readSize = spec.readSize;
      }
      if (this.nextAddress > cp.nextAddress)
        fail("VALIDATION", "Checkpoint allocation cursor precedes live memory");
      if (
        [...this.regions.keys()].some(
          (id) =>
            !/^region[1-9][0-9]*$/.test(id) || Number(id.slice(6)) >= cp.nextId,
        )
      )
        fail("VALIDATION", "Checkpoint region identity cursor is invalid");
      if (
        [...this.regions.values()].filter((r) => r.kind === "heap").length >
        cp.allocations
      )
        fail("VALIDATION", "Checkpoint allocation count is inconsistent");
      if (
        this.bufferCount > cp.bufferAllocations ||
        cp.nextId !== cp.allocations + cp.bufferAllocations + 1
      ) {
        fail(
          "VALIDATION",
          "Checkpoint region allocation cursors are inconsistent",
        );
      }
      this.nextAddress = cp.nextAddress;
      this.nextId = cp.nextId;
      this.bufferAllocations = cp.bufferAllocations;
      this.allocations = cp.allocations;
      this.calls = cp.calls;
      this.totalInstructions = cp.totalInstructions;
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      try {
        this.e.close();
      } catch {}
    }
  }
  const api = {
    ObjectEngine,
    validateModule,
    settings,
    canonical,
    digest,
    identity,
    MODEL,
    CapsuleError,
  };

  if (node) module.exports = api;
  else root.CapsulithObjectsCore = api;
})(typeof self === "object" ? self : globalThis);
