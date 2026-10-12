/* SPDX-License-Identifier: GPL-2.0-only */
import { runCapsule, validateCapsule } from "../runtime/browser.mjs";

const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const hexAddress = (value) =>
  Number.isSafeInteger(Number(value))
    ? `0x${Number(value).toString(16).padStart(6, "0")}`
    : String(value ?? "unknown");
const bytesCount = (hex) => Math.floor((hex?.length || 0) / 2);
const formatCount = (value) => Number(value || 0).toLocaleString("en-US");
const blankContract = () => ({
  buffers: [],
  args: [],
  return: "i32",
  imports: [],
});
const state = {
  artifact: null,
  metadata: null,
  selected: null,
  capsule: null,
  inputs: { buffers: {}, scalars: {} },
  result: null,
  examples: [],
  running: false,
  controller: null,
  revision: 0,
  modes: {},
  tracePage: 250,
  traceSelected: null,
  functionPage: 200,
};
let operationBusy = false;

function notify(message, error = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
  $("notice").hidden = !message;
}
function executionStatus(message, kind = "neutral") {
  $("execution-status").innerHTML =
    `<span class="status-dot ${escape(kind)}"></span>${escape(message)}`;
}
function setBusy(busy) {
  operationBusy = busy;
  updateControls();
}
function updateControls() {
  $("extract").disabled =
    !state.artifact || !state.selected || operationBusy || state.running;
  $("extract").textContent = operationBusy
    ? "Working…"
    : "Extract selected function ↗";
  $("run").disabled = !state.capsule || operationBusy || state.running;
  $("cancel").disabled = !state.running;
  $("export").disabled = !state.capsule || operationBusy || state.running;
  $("phase-artifact").classList.toggle(
    "active",
    !!state.artifact || !state.capsule,
  );
  $("phase-capsule").classList.toggle("active", !!state.capsule);
  $("phase-run").classList.toggle("active", !!state.result || state.running);
  $("reset").disabled = operationBusy;
  $("artifact-file").disabled = operationBusy || state.running;
  document
    .querySelectorAll(".specimen")
    .forEach((button) => (button.disabled = operationBusy || state.running));
  $("contract-panel").inert = state.running;
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    let error;
    try {
      error = await response.json();
    } catch {
      error = { message: `Request failed (${response.status})` };
    }
    const detail = error.error;
    const failure = new Error(
      typeof detail === "string"
        ? detail
        : detail?.message ||
            error.message ||
            `Request failed (${response.status})`,
    );
    failure.status = response.status;
    throw failure;
  }
  return response.json();
}
function base64(bytes) {
  let result = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    result += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(result);
}
function clearCapsule() {
  state.controller?.abort();
  state.controller = null;
  state.running = false;
  state.capsule = null;
  state.result = null;
  state.inputs = { buffers: {}, scalars: {} };
  state.modes = {};
  $("capsule-empty").hidden = false;
  $("capsule-content").hidden = true;
  $("capsule-title").textContent = "Capsule workbench";
  $("capsule-state").textContent = "AWAITING EXTRACTION";
  $("capsule-state").classList.remove("ready");
  $("results").hidden = true;
  $("results-empty").hidden = false;
  $("run-error").hidden = true;
  executionStatus("No execution yet");
  updateControls();
}
async function loadArtifact(file) {
  if (operationBusy || state.running) return;
  if (file.size > 32 * 1024 * 1024) {
    notify("Artifact exceeds the 32 MiB limit.", true);
    return;
  }
  const revision = ++state.revision;
  clearCapsule();
  state.artifact = null;
  state.metadata = null;
  state.selected = null;
  renderInventory();
  setBusy(true);
  notify(`Reading ${file.name} and inspecting function boundaries…`);
  $("file-label").textContent = file.name;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const artifact = base64(bytes);
    const metadata = await api("/api/inspect", { artifact });
    if (revision !== state.revision) return;
    state.artifact = artifact;
    state.metadata = metadata;
    renderInventory();
    notify(
      `Inspected ${formatCount(metadata.functions?.length)} function boundaries. Select a root to check its dependencies.`,
    );
  } catch (error) {
    if (revision === state.revision) {
      $("file-label").textContent = "Choose another artifact";
      notify(error.message, true);
    }
  } finally {
    setBusy(false);
  }
}
function renderInventory() {
  const functions = state.metadata?.functions || [];
  const query = $("function-search").value.toLowerCase();
  const filtered = functions.filter((fn) =>
    `${fn.name} ${(fn.aliases || []).join(" ")} ${hexAddress(fn.address)}`
      .toLowerCase()
      .includes(query),
  );
  $("function-count").textContent = formatCount(functions.length);
  $("function-search").disabled = !state.metadata;
  $("artifact-info").hidden = !state.metadata;
  if (state.metadata)
    $("artifact-info").innerHTML =
      `<div class="artifact-metadata">${escape(state.metadata.format || "Mach-O64 dylib")} / ${escape(state.metadata.architecture)}<br>${formatCount(state.metadata.artifactBytes)} bytes<span class="digest">SHA256 · ${escape(state.metadata.artifactSHA256)}</span></div>`;
  $("function-list").innerHTML = filtered.length
    ? filtered
        .slice(0, state.functionPage)
        .map(
          (fn) =>
            `<button class="function ${state.selected?.address === fn.address ? "selected" : ""}" data-address="${escape(fn.address)}" aria-pressed="${state.selected?.address === fn.address}"><strong>${escape(fn.name)}</strong><small><span>${hexAddress(fn.address)}</span><span>${formatCount(fn.size)} B · ${fn.exported ? "exported" : "private"}</span></small><div class="function-support">${escape(fn.supportStatus === "extracted" ? "Dependencies extracted" : fn.supportStatus === "unsupported" ? "Unsupported dependencies" : "Dependencies unchecked")}</div></button>`,
        )
        .join("") +
      (filtered.length > state.functionPage
        ? `<button class="trace-more" data-more-functions="true">Show next ${Math.min(200, filtered.length - state.functionPage)} functions</button>`
        : "")
    : `<div class="empty-inventory"><span class="crosshair">+</span><p>${state.metadata ? "No matching functions." : "No artifact selected.<br>Upload a dylib or open a specimen below."}</p></div>`;
  $("selected-function").hidden = !state.selected;
  if (state.selected)
    $("selected-function").innerHTML =
      `<div class="selected-detail"><strong>${escape(state.selected.name)}</strong><br>${hexAddress(state.selected.address)} → ${hexAddress(state.selected.end)}<br>Prototype unknown · caller declaration required${state.selected.supportReason ? `<br><span style="color:var(--red)">${escape(state.selected.supportReason)}</span>` : ""}</div>`;
  updateControls();
}
$("function-list").addEventListener("click", (event) => {
  if (event.target.closest("[data-more-functions]")) {
    state.functionPage += 200;
    renderInventory();
    return;
  }
  const button = event.target.closest("[data-address]");
  if (!button || operationBusy || state.running) return;
  state.selected = state.metadata.functions.find(
    (fn) => String(fn.address) === button.dataset.address,
  );
  renderInventory();
});
$("function-search").addEventListener("input", () => {
  state.functionPage = 200;
  renderInventory();
});
$("artifact-file").addEventListener("change", (event) => {
  if (event.target.files[0]) loadArtifact(event.target.files[0]);
  event.target.value = "";
});
for (const name of ["dragenter", "dragover"])
  $("dropzone").addEventListener(name, (event) => {
    event.preventDefault();
    if (!operationBusy && !state.running)
      $("dropzone").classList.add("dragging");
  });
for (const name of ["dragleave", "drop"])
  $("dropzone").addEventListener(name, (event) => {
    event.preventDefault();
    $("dropzone").classList.remove("dragging");
  });
$("dropzone").addEventListener("drop", (event) => {
  const file = event.dataTransfer.files[0];
  if (file) loadArtifact(file);
});
$("extract").addEventListener("click", async () => {
  if (!state.artifact || !state.selected || operationBusy) return;
  const revision = ++state.revision;
  const root = state.selected.address;
  clearCapsule();
  setBusy(true);
  notify(`Extracting ${state.selected.name} and its dependency closure…`);
  try {
    const capsule = await api("/api/extract", {
      artifact: state.artifact,
      root,
    });
    if (revision !== state.revision) return;
    loadCapsule(capsule);
    notify(
      "Original bytes extracted. Declare the calling contract before executing.",
    );
  } catch (error) {
    const rejected = error.status === 400 || error.status === 422;
    notify(
      `${rejected ? "Extraction rejected" : "Extraction failed"}: ${error.message}`,
      true,
    );
    $("capsule-state").textContent = rejected
      ? "EXTRACTION REJECTED"
      : "EXTRACTION FAILED";
    if (
      rejected &&
      /unsupported|unknown direct target|writable|relocat|static pointer|indirect/i.test(
        error.message,
      )
    ) {
      state.selected.supportStatus = "unsupported";
      state.selected.supportReason = error.message;
    }
    renderInventory();
  } finally {
    setBusy(false);
  }
});

function loadCapsule(capsule, inputs = { buffers: {}, scalars: {} }) {
  state.capsule = structuredClone(capsule);
  state.capsule.contract ??= blankContract();
  state.inputs = structuredClone(inputs);
  state.inputs.buffers ??= {};
  state.inputs.scalars ??= {};
  state.modes = {};
  state.result = null;
  $("capsule-empty").hidden = true;
  $("capsule-content").hidden = false;
  $("capsule-state").textContent = "ORIGINAL BYTES";
  $("capsule-state").classList.add("ready");
  $("capsule-title").textContent = "Capsule workbench";
  const codeBytes = state.capsule.chunks
    .filter((chunk) => chunk.kind === "code")
    .reduce((sum, chunk) => sum + bytesCount(chunk.bytes), 0);
  const dataBytes = state.capsule.chunks
    .filter((chunk) => chunk.kind === "readonly")
    .reduce((sum, chunk) => sum + bytesCount(chunk.bytes), 0);
  const root = state.capsule.extraction?.root;
  const name =
    typeof root === "object"
      ? root.name || hexAddress(root.address)
      : root || state.selected?.name || "Callable capsule";
  $("capsule-summary").innerHTML =
    `<div><strong>${escape(name)}</strong><small>Entry ${hexAddress(capsule.entry)} · ${escape(capsule.architecture)} · schema ${escape(capsule.schema)}</small></div><div class="capsule-metrics"><div><b>${formatCount(codeBytes)}</b><span>CODE BYTES</span></div><div><b>${formatCount(dataBytes)}</b><span>READONLY</span></div></div>`;
  renderContract();
  renderEvidence();
  $("results").hidden = true;
  $("results-empty").hidden = false;
  $("run-error").hidden = true;
  executionStatus("Ready · contract is caller-declared");
  setTab("contract");
  updateControls();
}
function syncJSON() {
  if (state.capsule)
    $("contract-json").value = JSON.stringify(state.capsule.contract, null, 2);
}
function bufferValue(buffer) {
  const value = state.inputs.buffers[buffer.name] || "";
  if (state.modes[buffer.name] === "text") {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        hexToBytes(value),
      );
    } catch {
      return "";
    }
  }
  return value;
}
function renderContract() {
  const contract = state.capsule.contract;
  $("buffer-editor").innerHTML = contract.buffers.length
    ? contract.buffers
        .map(
          (buffer, index) =>
            `<div class="buffer-row"><div class="buffer-fields"><div class="field"><label for="buffer-name-${index}">Name</label><input id="buffer-name-${index}" value="${escape(buffer.name)}" data-buffer="${index}" data-field="name" spellcheck="false"></div><div class="field"><label for="buffer-access-${index}">Access</label><select id="buffer-access-${index}" data-buffer="${index}" data-field="access">${["read", "write", "readwrite"].map((access) => `<option ${access === buffer.access ? "selected" : ""}>${access}</option>`).join("")}</select></div><div class="field"><label for="buffer-capacity-${index}">Capacity · B</label><input id="buffer-capacity-${index}" data-buffer="${index}" data-field="capacity" type="number" min="0" max="16777216" value="${escape(buffer.capacity)}"></div><button class="remove" data-remove-buffer="${index}" aria-label="Remove buffer ${escape(buffer.name)}">×</button></div><label class="buffer-input-label" for="buffer-bytes-${index}">Initial bytes ${buffer.access === "write" ? "· optional; output starts zero-filled" : ""}<textarea id="buffer-bytes-${index}" data-input-buffer="${index}" spellcheck="false" rows="2" placeholder="${buffer.access === "write" ? "Empty output buffer" : "Hexadecimal bytes"}">${escape(bufferValue(buffer))}</textarea></label><div class="buffer-foot"><span id="buffer-count-${index}">${formatCount(bytesCount(state.inputs.buffers[buffer.name]))} input bytes / ${formatCount(buffer.capacity)} capacity</span><label><span class="sr-only">Input encoding for ${escape(buffer.name)}</span><select class="encoding-select" data-encoding="${index}"><option value="hex" ${state.modes[buffer.name] !== "text" ? "selected" : ""}>HEX</option><option value="text" ${state.modes[buffer.name] === "text" ? "selected" : ""}>UTF-8 TEXT</option></select></label></div></div>`,
        )
        .join("")
    : '<p class="empty-editor">No buffers declared. Add named buffers to pass bounded memory into the function.</p>';
  $("arg-editor").innerHTML = contract.args.length
    ? contract.args
        .map(
          (arg, index) =>
            `<div class="arg-row"><span class="register">x${index}</span><label><span class="sr-only">Argument x${index} kind</span><select data-arg="${index}" data-field="kind">${["buffer", "length", "capacity", "scalar"].map((kind) => `<option ${arg.kind === kind ? "selected" : ""}>${kind}</option>`).join("")}</select></label>${arg.kind === "scalar" ? `<label><span class="sr-only">Scalar x${index} name</span><input value="${escape(arg.name)}" data-arg="${index}" data-field="name" spellcheck="false"></label><label><span class="sr-only">Scalar x${index} type</span><select data-arg="${index}" data-field="type">${["i32", "u32", "i64", "u64"].map((type) => `<option ${arg.type === type ? "selected" : ""}>${type}</option>`).join("")}</select></label>` : `<label style="grid-column:3 / 5"><span class="sr-only">Argument x${index} buffer</span><select data-arg="${index}" data-field="buffer">${contract.buffers.map((buffer) => `<option value="${escape(buffer.name)}" ${arg.buffer === buffer.name ? "selected" : ""}>${escape(buffer.name)}</option>`).join("")}${!contract.buffers.length ? '<option value="">Add a buffer first</option>' : ""}</select></label>`}<button class="remove" data-remove-arg="${index}" aria-label="Remove argument x${index}">×</button></div>${arg.kind === "scalar" ? `<label class="arg-value">${escape(arg.name)} · ${escape(arg.type)}<input aria-label="Value for scalar ${escape(arg.name)}" data-input-scalar="${index}" value="${escape(state.inputs.scalars[arg.name] ?? (arg.type.endsWith("64") ? "0" : 0))}" inputmode="numeric" spellcheck="false"></label>` : ""}`,
        )
        .join("")
    : '<p class="empty-editor">No register arguments declared. Add arguments in the native function’s calling order.</p>';
  $("return-type").value = contract.return;
  document
    .querySelectorAll("#import-checks input")
    .forEach(
      (input) =>
        (input.checked = (contract.imports || []).includes(input.value)),
    );
  $("add-arg").disabled = contract.args.length >= 8;
  syncJSON();
}
$("buffer-editor").addEventListener("input", (event) => {
  if (event.target.dataset.inputBuffer !== undefined) {
    const index = Number(event.target.dataset.inputBuffer),
      buffer = state.capsule.contract.buffers[index];
    const value = event.target.value;
    state.inputs.buffers[buffer.name] =
      state.modes[buffer.name] === "text"
        ? bytesToHex(new TextEncoder().encode(value))
        : value.replace(/\s/g, "");
    $(`buffer-count-${index}`).textContent =
      `${formatCount(bytesCount(state.inputs.buffers[buffer.name]))} input bytes / ${formatCount(buffer.capacity)} capacity`;
  }
});
$("buffer-editor").addEventListener("change", (event) => {
  if (event.target.dataset.buffer !== undefined) {
    const buffer =
        state.capsule.contract.buffers[Number(event.target.dataset.buffer)],
      field = event.target.dataset.field;
    if (field === "name") {
      const old = buffer.name;
      buffer.name = event.target.value;
      state.inputs.buffers[buffer.name] = state.inputs.buffers[old] || "";
      state.modes[buffer.name] = state.modes[old];
      if (old !== buffer.name) {
        delete state.inputs.buffers[old];
        delete state.modes[old];
      }
      state.capsule.contract.args.forEach((arg) => {
        if (arg.buffer === old) arg.buffer = buffer.name;
      });
    } else
      buffer[field] =
        field === "capacity" ? Number(event.target.value) : event.target.value;
    renderContract();
  }
  if (event.target.dataset.encoding !== undefined) {
    const buffer =
      state.capsule.contract.buffers[Number(event.target.dataset.encoding)];
    if (event.target.value === "text") {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(
          hexToBytes(state.inputs.buffers[buffer.name] || ""),
        );
      } catch {
        notify(
          "These input bytes are not valid UTF-8. Keep HEX encoding to preserve exact bytes.",
          true,
        );
        event.target.value = "hex";
        return;
      }
    }
    state.modes[buffer.name] = event.target.value;
    renderContract();
  }
});
$("buffer-editor").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-buffer]");
  if (!button) return;
  const index = Number(button.dataset.removeBuffer),
    name = state.capsule.contract.buffers[index].name;
  state.capsule.contract.buffers.splice(index, 1);
  state.capsule.contract.args = state.capsule.contract.args.filter(
    (arg) => arg.buffer !== name,
  );
  delete state.inputs.buffers[name];
  delete state.modes[name];
  renderContract();
});
$("add-buffer").addEventListener("click", () => {
  const buffers = state.capsule.contract.buffers;
  let index = buffers.length + 1;
  while (buffers.some((buffer) => buffer.name === `buffer${index}`)) index++;
  buffers.push({ name: `buffer${index}`, access: "read", capacity: 256 });
  state.inputs.buffers[`buffer${index}`] = "";
  renderContract();
});
$("add-arg").addEventListener("click", () => {
  const contract = state.capsule.contract;
  if (contract.args.length >= 8) return;
  const arg = contract.buffers.length
    ? { kind: "buffer", buffer: contract.buffers[0].name }
    : { kind: "scalar", name: `value${contract.args.length}`, type: "i32" };
  contract.args.push(arg);
  if (arg.kind === "scalar") state.inputs.scalars[arg.name] = 0;
  renderContract();
});
function cleanScalars() {
  const names = new Set(
    state.capsule.contract.args
      .filter((arg) => arg.kind === "scalar")
      .map((arg) => arg.name),
  );
  for (const name of Object.keys(state.inputs.scalars))
    if (!names.has(name)) delete state.inputs.scalars[name];
}
$("arg-editor").addEventListener("input", (event) => {
  if (event.target.dataset.inputScalar === undefined) return;
  const arg =
    state.capsule.contract.args[Number(event.target.dataset.inputScalar)];
  state.inputs.scalars[arg.name] = arg.type.endsWith("64")
    ? event.target.value
    : event.target.value.trim() === ""
      ? NaN
      : Number(event.target.value);
});
$("arg-editor").addEventListener("change", (event) => {
  if (event.target.dataset.arg === undefined) return;
  const index = Number(event.target.dataset.arg),
    arg = state.capsule.contract.args[index],
    field = event.target.dataset.field;
  if (field === "kind") {
    state.capsule.contract.args[index] =
      event.target.value === "scalar"
        ? { kind: "scalar", name: `value${index}`, type: "i32" }
        : {
            kind: event.target.value,
            buffer: state.capsule.contract.buffers[0]?.name || "",
          };
  } else if (field === "name") {
    state.inputs.scalars[event.target.value] =
      state.inputs.scalars[arg.name] ?? 0;
    arg.name = event.target.value;
  } else {
    arg[field] = event.target.value;
    if (field === "type")
      state.inputs.scalars[arg.name] = arg.type.endsWith("64")
        ? String(state.inputs.scalars[arg.name] ?? 0)
        : Number(state.inputs.scalars[arg.name] ?? 0);
  }
  cleanScalars();
  renderContract();
});
$("arg-editor").addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-arg]");
  if (!button) return;
  state.capsule.contract.args.splice(Number(button.dataset.removeArg), 1);
  cleanScalars();
  renderContract();
});
$("return-type").addEventListener("change", (event) => {
  state.capsule.contract.return = event.target.value;
  syncJSON();
});
$("import-checks").addEventListener("change", () => {
  state.capsule.contract.imports = [
    ...document.querySelectorAll("#import-checks input:checked"),
  ].map((input) => input.value);
  syncJSON();
});
function safeContract(contract) {
  if (
    !contract ||
    typeof contract !== "object" ||
    !Array.isArray(contract.buffers) ||
    !Array.isArray(contract.args)
  )
    throw new Error("Contract requires buffers and args arrays.");
  if (contract.buffers.length > 64 || contract.args.length > 8)
    throw new Error(
      "At most 64 buffers and eight register arguments are supported.",
    );
  const names = new Set();
  for (const buffer of contract.buffers) {
    if (
      !buffer ||
      !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(buffer.name) ||
      ["__proto__", "constructor", "prototype"].includes(buffer.name) ||
      names.has(buffer.name)
    )
      throw new Error("Buffer names must be valid and unique.");
    names.add(buffer.name);
    if (
      !["read", "write", "readwrite"].includes(buffer.access) ||
      !Number.isSafeInteger(buffer.capacity) ||
      buffer.capacity < 0 ||
      buffer.capacity > 16777216
    )
      throw new Error(
        "Every buffer requires valid access and a bounded integer capacity.",
      );
  }
  for (const arg of contract.args) {
    if (!arg) throw new Error("Every argument must be an object.");
    if (arg.kind === "scalar") {
      if (
        !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(arg.name) ||
        ["__proto__", "constructor", "prototype"].includes(arg.name) ||
        !["i32", "u32", "i64", "u64"].includes(arg.type)
      )
        throw new Error("Every scalar requires a valid name and type.");
    } else if (
      !["buffer", "length", "capacity"].includes(arg.kind) ||
      !names.has(arg.buffer)
    )
      throw new Error("Buffer arguments must refer to declared buffers.");
  }
  if (!["i32", "u32", "i64", "u64"].includes(contract.return))
    throw new Error("Return type must be i32, u32, i64 or u64.");
  if (
    contract.imports !== undefined &&
    (!Array.isArray(contract.imports) ||
      contract.imports.some(
        (name) => !["memmove", "memcpy", "memset"].includes(name),
      ) ||
      new Set(contract.imports).size !== contract.imports.length)
  )
    throw new Error(
      "Imports may declare memmove, memcpy and memset once each.",
    );
  return contract;
}
$("apply-contract").addEventListener("click", () => {
  try {
    const contract = safeContract(JSON.parse($("contract-json").value));
    state.capsule.contract = contract;
    for (const name of Object.keys(state.inputs.buffers))
      if (!contract.buffers.some((buffer) => buffer.name === name))
        delete state.inputs.buffers[name];
    for (const buffer of contract.buffers)
      state.inputs.buffers[buffer.name] ??= "";
    cleanScalars();
    for (const arg of contract.args)
      if (arg.kind === "scalar")
        state.inputs.scalars[arg.name] ??= arg.type.endsWith("64") ? "0" : 0;
    for (const arg of contract.args)
      if (arg.kind === "scalar")
        state.inputs.scalars[arg.name] = arg.type.endsWith("64")
          ? String(state.inputs.scalars[arg.name])
          : Number(state.inputs.scalars[arg.name]);
    renderContract();
    notify("Caller-declared contract applied. Input values remain editable.");
  } catch (error) {
    notify(`Contract not applied: ${error.message}`, true);
  }
});

function setTab(name) {
  for (const tab of ["contract", "evidence"]) {
    const selected = tab === name;
    $(`${tab}-tab`).setAttribute("aria-selected", selected);
    $(`${tab}-tab`).tabIndex = selected ? 0 : -1;
    $(`${tab}-panel`).hidden = !selected;
  }
}
for (const name of ["contract", "evidence"]) {
  $(`${name}-tab`).addEventListener("click", () => setTab(name));
  $(`${name}-tab`).addEventListener("keydown", (event) => {
    if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === "Home"
          ? "contract"
          : event.key === "End"
            ? "evidence"
            : name === "contract"
              ? "evidence"
              : "contract";
      setTab(next);
      $(`${next}-tab`).focus();
    }
  });
}
function instructionsFor(chunk) {
  const instructions =
    state.capsule.extraction?.instructions || chunk.disassembly || [];
  return instructions.filter((instruction) => {
    const address = Number(instruction.address);
    return (
      address >= chunk.address &&
      address < chunk.address + bytesCount(chunk.bytes)
    );
  });
}
function renderEvidence() {
  const capsule = state.capsule,
    extraction = capsule.extraction || {},
    functions = extraction.functions || [];
  const root =
    typeof extraction.root === "object"
      ? extraction.root.name
      : extraction.root || state.selected?.name || hexAddress(capsule.entry);
  const edges = extraction.dependencies || [];
  const transfers = edges.filter((edge) => edge.kind !== "branch");
  $("dependency-view").innerHTML =
    `<div class="dependency-root"><span class="root-marker">R</span><span>${escape(root)}</span></div>${functions
      .filter((fn) => fn.address !== capsule.entry && fn.name !== root)
      .map(
        (fn) =>
          `<div class="dependency-edge">↳ ${escape(fn.name || hexAddress(fn.address))}<span>Original helper · ${formatCount(fn.size)} bytes · dependencies extracted</span></div>`,
      )
      .join(
        "",
      )}${(capsule.imports || []).map((item) => `<div class="dependency-edge import-edge">↳ ${escape(item.name)}<span>Import at ${hexAddress(item.address)} · explicit contract permission required</span></div>`).join("")}${transfers.length ? `<details class="dependency-transfers" open><summary>${formatCount(transfers.length)} helper / import transfers · ${formatCount(edges.length - transfers.length)} local branches</summary>${transfers.map((edge) => `<button class="dependency-transfer" data-instruction="${escape(edge.from)}"><span>${escape(functions.find((fn) => fn.address === edge.function)?.name || hexAddress(edge.function))}</span><strong>${hexAddress(edge.from)} → ${escape(functions.find((fn) => fn.address === edge.to)?.name || capsule.imports?.find((item) => item.address === edge.to)?.name || hexAddress(edge.to))}</strong><small>${escape(edge.kind)} · inspect call-site bytes ↗</small></button>`).join("")}</details>` : ""}${!functions.length ? `<p class="evidence-note">${escape(edges.length ? `${edges.length} dependency edges recorded.` : "No function-level dependency record supplied. Review capsule chunks below.")}</p>` : ""}<p class="evidence-note">Prototype unknown. Extracted dependency support does not establish that the caller’s argument declaration is correct.</p>${extraction.limitations?.length ? `<ul class="limits-list">${extraction.limitations.map((item) => `<li>${escape(item)}</li>`).join("")}</ul>` : ""}`;
  const total = capsule.chunks.reduce(
    (sum, chunk) => sum + bytesCount(chunk.bytes),
    0,
  );
  $("memory-map").innerHTML =
    `<div class="memory-strip" aria-label="Relative size of capsule chunks">${capsule.chunks.map((chunk) => `<span class="${escape(chunk.kind)}" style="flex:${Math.max(bytesCount(chunk.bytes) / total, 0.015)}" title="${escape(chunk.name)}: ${bytesCount(chunk.bytes)} bytes"></span>`).join("")}</div>${capsule.chunks.map((chunk) => `<button class="layout-row" data-chunk="${capsule.chunks.indexOf(chunk)}" title="Inspect original bytes for ${escape(chunk.name)}"><span class="layout-type ${escape(chunk.kind)}">${chunk.kind === "code" ? "CODE / RX" : "DATA / R"}</span><span>${hexAddress(chunk.address)}</span><span class="region-name">${escape(chunk.name)}<span class="layout-size">${formatCount(bytesCount(chunk.bytes))} original bytes</span></span></button>`).join("")}<p class="evidence-note">Code and readonly chunks retain original artifact addresses. The runtime adds 0x1000000 to these addresses; buffers and stack use separate regions.</p>`;
  $("chunk-select").innerHTML = capsule.chunks
    .map(
      (chunk, index) =>
        `<option value="${index}">${escape(chunk.name || `chunk${index}`)}</option>`,
    )
    .join("");
  renderChunk();
  $("provenance").textContent = JSON.stringify(
    {
      artifactSHA256: capsule.artifactSHA256,
      extraction,
      imports: capsule.imports,
    },
    null,
    2,
  );
}
function renderChunk() {
  const index = Number($("chunk-select").value || 0),
    chunk = state.capsule?.chunks[index];
  if (!chunk) return;
  const instructions = instructionsFor(chunk);
  $("chunk-view").innerHTML = instructions.length
    ? instructions
        .slice(0, 3000)
        .map(
          (instruction) =>
            `<div class="instruction-row" data-byte-address="${escape(instruction.address)}"><span class="address">${hexAddress(instruction.address)}</span><span class="bytes">${escape(instruction.bytes)}</span><span><strong>${escape(instruction.mnemonic)}</strong> ${escape(instruction.operands || instruction.op_str || "")}</span></div>`,
        )
        .join("")
    : `<pre class="byte-row">${escape(hexDump(chunk.bytes, chunk.address, 16384))}</pre>`;
}
$("chunk-select").addEventListener("change", renderChunk);
$("memory-map").addEventListener("click", (event) => {
  const button = event.target.closest("[data-chunk]");
  if (!button) return;
  $("chunk-select").value = button.dataset.chunk;
  renderChunk();
  $("chunk-select").focus();
});
$("dependency-view").addEventListener("click", (event) => {
  const button = event.target.closest("[data-instruction]");
  if (!button) return;
  const address = Number(button.dataset.instruction),
    index = state.capsule.chunks.findIndex(
      (chunk) =>
        address >= chunk.address &&
        address < chunk.address + bytesCount(chunk.bytes),
    );
  if (index < 0) return;
  $("chunk-select").value = String(index);
  renderChunk();
  const row = $("chunk-view").querySelector(`[data-byte-address="${address}"]`);
  if (row) {
    row.classList.add("current");
    row.scrollIntoView({ block: "nearest" });
  }
});
$("contract-panel").addEventListener("input", () => {
  if (state.result && !state.running)
    executionStatus("Inputs edited · showing the previous execution");
});
$("contract-panel").addEventListener("change", () => {
  if (state.result && !state.running)
    executionStatus("Contract or inputs edited · run again for fresh evidence");
});

function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}
function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 || !/^[a-fA-F0-9]*$/.test(hex))
    throw new Error("Input must contain complete hexadecimal bytes.");
  return Uint8Array.from(hex.match(/../g) || [], (value) =>
    parseInt(value, 16),
  );
}
function hexDump(hex, address = 0, maxBytes = 256) {
  const total = bytesCount(hex),
    bytes = hexToBytes(hex.slice(0, maxBytes * 2));
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const slice = bytes.subarray(i, Math.min(i + 16, maxBytes));
    lines.push(
      `${hexAddress(address + i)}  ${[...slice]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join(" ")
        .padEnd(
          47,
        )}  ${[...slice].map((value) => (value >= 32 && value <= 126 ? String.fromCharCode(value) : "·")).join("")}`,
    );
  }
  if (total > maxBytes)
    lines.push(`… ${formatCount(total - maxBytes)} more bytes`);
  return lines.join("\n");
}
function settings() {
  return {
    instructionLimit: Number($("instruction-limit").value),
    traceLimit: Number($("trace-limit").value),
    timeoutMs: Number($("timeout").value),
  };
}
function pruneInputs() {
  const contract = state.capsule.contract;
  for (const name of Object.keys(state.inputs.buffers))
    if (!contract.buffers.some((buffer) => buffer.name === name))
      delete state.inputs.buffers[name];
  cleanScalars();
  for (const buffer of contract.buffers)
    state.inputs.buffers[buffer.name] ??= "";
  for (const arg of contract.args)
    if (arg.kind === "scalar")
      state.inputs.scalars[arg.name] ??= arg.type.endsWith("64") ? "0" : 0;
}
$("run").addEventListener("click", async () => {
  if (!state.capsule || state.running || operationBusy) return;
  const revision = state.revision;
  state.controller = new AbortController();
  state.running = true;
  state.result = null;
  $("results").hidden = true;
  $("results-empty").hidden = true;
  $("run-error").hidden = true;
  notify("");
  executionStatus("Executing original ARM64 bytes…", "running");
  updateControls();
  try {
    if (
      $("contract-json").value !==
      JSON.stringify(state.capsule.contract, null, 2)
    )
      throw new Error(
        "Apply your advanced JSON contract edits before running.",
      );
    pruneInputs();
    const options = { ...settings(), signal: state.controller.signal };
    const capsule = structuredClone(state.capsule),
      inputs = structuredClone(state.inputs);
    validateCapsule(capsule, inputs, options);
    const result = await runCapsule(capsule, inputs, options);
    if (revision !== state.revision) return;
    state.result = result;
    renderResult();
    executionStatus("Returned · execution evidence captured", "");
  } catch (error) {
    if (revision !== state.revision) return;
    const cancelled = error.code === "CANCELLED";
    executionStatus(
      cancelled
        ? "Cancelled · worker terminated"
        : `Stopped · ${error.code || "ERROR"}`,
      cancelled ? "neutral" : "error",
    );
    $("run-error").hidden = false;
    $("run-error").innerHTML =
      `<strong>${escape(error.code || "EXECUTION_ERROR")}</strong>${escape(error.message)}${error.details && Object.keys(error.details).some((key) => !["trace", "stats"].includes(key)) ? `<pre>${escape(JSON.stringify(Object.fromEntries(Object.entries(error.details).filter(([key]) => !["trace", "stats"].includes(key))), null, 2))}</pre>` : ""}`;
    if (error.details?.trace || error.details?.stats) {
      state.result = {
        trace: error.details.trace || [],
        stats: error.details.stats || {},
        outputs: {},
        partial: true,
      };
      renderResult();
    } else $("results-empty").hidden = false;
  } finally {
    if (revision === state.revision) {
      state.running = false;
      state.controller = null;
      updateControls();
    }
  }
});
$("cancel").addEventListener("click", () => {
  state.controller?.abort();
  executionStatus("Cancelling worker…", "neutral");
});
function renderResult() {
  const result = state.result;
  $("results").hidden = false;
  $("results-empty").hidden = true;
  $("result-type").textContent = state.capsule.contract.return;
  $("return-value").textContent = result.partial
    ? "Stopped"
    : String(result.returnValue);
  $("return-interpretation").textContent = result.partial
    ? "Partial trace only. No successful return or output claim."
    : `${state.capsule.contract.return.startsWith("i") ? "Signed" : "Unsigned"} ${state.capsule.contract.return.endsWith("64") ? "64" : "32"}-bit return value`;
  const stats = result.stats || {};
  $("stats").innerHTML = [
    ["INSTRUCTIONS", formatCount(stats.instructions)],
    [
      "WALL TIME",
      stats.wallMilliseconds === undefined
        ? "—"
        : `${Number(stats.wallMilliseconds).toFixed(1)} ms`,
    ],
    [
      "READ / WRITE",
      `${formatCount(stats.reads)} / ${formatCount(stats.writes)}`,
    ],
    [
      "BYTES R / W",
      `${formatCount(stats.readBytes)} / ${formatCount(stats.writeBytes)}`,
    ],
  ]
    .map(
      ([label, value]) =>
        `<div class="stat"><strong>${escape(value)}</strong><span>${label}</span></div>`,
    )
    .join("");
  const outputs = Object.entries(result.outputs || {});
  $("outputs").innerHTML = outputs.length
    ? outputs
        .map(
          ([name, hex]) =>
            `<div class="output-buffer"><div class="output-top"><strong>${escape(name)} · ${formatCount(bytesCount(hex))} B</strong><button class="download" data-output="${escape(name)}">↓ bytes</button></div><pre>${escape(hexDump(hex, 0, 256))}</pre><div class="decoded">UTF-8 preview · ${escape(
              new TextDecoder()
                .decode(hexToBytes(hex.slice(0, 640)))
                .replace(/\0/g, "·")
                .slice(0, 320),
            )}</div></div>`,
        )
        .join("")
    : `<p class="small muted">${result.partial ? "Outputs are unavailable for a stopped execution." : "No writable buffers declared. Return value and trace are available."}</p>`;
  state.tracePage = 250;
  state.traceSelected = null;
  renderTrace();
  $("trace-detail").textContent =
    "Select an event to inspect its region, offset and original bytes.";
  updateControls();
}
function renderTrace() {
  const filter = $("trace-filter").value,
    trace = state.result?.trace || [];
  const filtered = trace
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => filter === "all" || event.kind === filter);
  $("trace-count").textContent =
    `${formatCount(filtered.length)} / ${formatCount(trace.length)}`;
  $("trace-list").innerHTML =
    filtered
      .slice(0, state.tracePage)
      .map(
        ({ event, index }) =>
          `<button class="trace-event ${state.traceSelected === index ? "selected" : ""}" data-trace="${index}" aria-label="Event ${index + 1}, ${escape(event.kind)}, ${escape(event.region)}, offset ${escape(event.offset)}"><span class="event-number">${String(index + 1).padStart(4, "0")}</span><span class="trace-kind ${escape(event.kind)}" title="${escape(event.kind)}">${event.kind === "instruction" ? "I" : event.kind === "write" ? "W" : "R"}</span><span>${hexAddress(event.address)}</span><span class="trace-location">${escape(event.region)} +${escape(event.offset)}</span></button>`,
      )
      .join("") +
      (filtered.length > state.tracePage
        ? `<button class="trace-more" data-more="true">Show next ${Math.min(250, filtered.length - state.tracePage)} events</button>`
        : "") ||
    '<p class="small muted" style="padding:14px">No events for this filter. Trace capture may have been disabled.</p>';
}
$("trace-filter").addEventListener("change", () => {
  state.tracePage = 250;
  renderTrace();
});
$("trace-list").addEventListener("click", (event) => {
  if (event.target.closest("[data-more]")) {
    state.tracePage += 250;
    renderTrace();
    return;
  }
  const button = event.target.closest("[data-trace]");
  if (!button) return;
  const index = Number(button.dataset.trace);
  state.traceSelected = index;
  renderTrace();
  showTraceDetail(state.result.trace[index], index);
});
function showTraceDetail(event, index) {
  const chunk =
    state.capsule.chunks.find(
      (chunk, position) => (chunk.name || `chunk${position}`) === event.region,
    ) ||
    state.capsule.chunks.find(
      (chunk) =>
        event.address - 0x1000000 >= chunk.address &&
        event.address - 0x1000000 < chunk.address + bytesCount(chunk.bytes),
    );
  let evidence = "";
  if (chunk) {
    const offset = Number(event.offset) || 0,
      start = Math.max(0, Math.floor(offset / 16) * 16 - 16),
      finish = Math.min(bytesCount(chunk.bytes), start + 64);
    const address = chunk.address + offset;
    const instruction = instructionsFor(chunk).find(
      (item) => Number(item.address) === address,
    );
    evidence = `<div class="detail-label">ORIGINAL CAPSULE BYTES · ${escape(chunk.name)}</div><pre>${escape(hexDump(chunk.bytes.slice(start * 2, finish * 2), chunk.address + start, 64))}</pre>${instruction ? `<div class="detail-label">EXTRACTED DISASSEMBLY</div><pre>${escape(`${hexAddress(instruction.address)}  ${instruction.mnemonic} ${instruction.operands || instruction.op_str || ""}`)}</pre>` : event.kind === "instruction" ? '<p class="small muted">No disassembly record for this instruction address.</p>' : ""}`;
  } else if (event.regionKind === "buffer") {
    evidence =
      '<p class="small muted" style="margin-top:10px">This event refers to caller memory. The trace records access location and size; it does not record a historical byte snapshot.</p>';
  } else if (event.regionKind === "import") {
    evidence =
      '<p class="small muted" style="margin-top:10px">Declared memory import model. Its bounded reads and writes appear as separate events.</p>';
  } else
    evidence =
      '<p class="small muted" style="margin-top:10px">Runtime region. No original artifact chunk corresponds to this memory.</p>';
  $("trace-detail").innerHTML =
    `<strong>EVENT ${index + 1} / ${escape(event.kind.toUpperCase())}</strong>Region ${escape(event.region)} · ${escape(event.regionKind || "unknown")}<br>Offset +${escape(event.offset)} · ${escape(event.size)} bytes<br>Runtime address ${hexAddress(event.address)}${event.model ? `<br>Import model ${escape(event.model)}` : ""}${evidence}`;
}
function download(blob, name) {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("outputs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-output]");
  if (!button) return;
  const name = button.dataset.output;
  download(
    new Blob([hexToBytes(state.result.outputs[name])], {
      type: "application/octet-stream",
    }),
    `${name}.bin`,
  );
});
$("export").addEventListener("click", async () => {
  if (!state.capsule || state.running || operationBusy) return;
  setBusy(true);
  notify("Preparing portable capsule with runtime and licenses…");
  try {
    if (
      $("contract-json").value !==
      JSON.stringify(state.capsule.contract, null, 2)
    )
      throw new Error(
        "Apply your advanced JSON contract edits before exporting.",
      );
    pruneInputs();
    validateCapsule(state.capsule, state.inputs);
    const response = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capsule: state.capsule, inputs: state.inputs }),
    });
    if (!response.ok) {
      let error;
      try {
        error = await response.json();
      } catch {
        error = {};
      }
      throw new Error(
        typeof error.error === "string"
          ? error.error
          : error.error?.message ||
              error.message ||
              `Export failed (${response.status})`,
      );
    }
    download(await response.blob(), "capsulith-portable.zip");
    notify(
      "Portable ZIP downloaded with the declared contract and current inputs.",
    );
  } catch (error) {
    notify(`Export failed: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
});
$("reset").addEventListener("click", () => {
  state.revision++;
  clearCapsule();
  notify(
    state.artifact
      ? "Workbench reset. Original uploaded artifact and inventory retained."
      : "Workbench reset. Choose an artifact or specimen.",
  );
});
async function loadExample(index) {
  if (operationBusy || state.running) return;
  const example = state.examples[index],
    revision = ++state.revision;
  clearCapsule();
  setBusy(true);
  notify(`Opening ${example.title}…`);
  try {
    let metadata = null;
    if (example.artifactBase64)
      metadata = await api("/api/inspect", {
        artifact: example.artifactBase64,
      });
    if (revision !== state.revision) return;
    state.artifact = example.artifactBase64 || null;
    state.metadata = metadata;
    state.selected =
      metadata?.functions.find(
        (fn) => fn.name === example.root || fn.address === example.root,
      ) || null;
    $("function-search").value = "";
    $("file-label").textContent = example.artifactBase64
      ? `${example.title} · specimen artifact`
      : "Drop a compiled artifact";
    renderInventory();
    loadCapsule(example.capsule, example.inputs);
    notify(
      `${example.title} loaded. Contract and input bytes are supplied by the specimen. Press Run to collect fresh evidence.`,
    );
  } catch (error) {
    notify(`Could not open specimen: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
}
$("examples").addEventListener("click", (event) => {
  const button = event.target.closest("[data-example]");
  if (button) loadExample(Number(button.dataset.example));
});
async function initialize() {
  try {
    const response = await api("/api/examples");
    state.examples = Array.isArray(response)
      ? response
      : response.examples || [];
    $("examples").innerHTML = state.examples.length
      ? state.examples
          .map(
            (example, index) =>
              `<button class="specimen" data-example="${index}"><span class="specimen-index">${String(index + 1).padStart(2, "0")}</span><span><strong>${escape(example.title)}</strong><p>${escape(example.description)}</p></span><span class="specimen-arrow">↗</span></button>`,
          )
          .join("")
      : '<p class="small muted">No specimens installed. Upload a supported artifact to begin.</p>';
    updateControls();
  } catch (error) {
    $("examples").innerHTML =
      '<p class="small muted">Specimens unavailable. Upload an artifact to begin.</p>';
    notify(`Local server unavailable: ${error.message}`, true);
  }
}
initialize();
