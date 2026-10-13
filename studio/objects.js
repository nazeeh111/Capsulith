/* SPDX-License-Identifier: GPL-2.0-only */
import { createModule } from '../runtime/objects.mjs';
import { hexBytes, integerArgument, bytePreview, initializedCount, oracleMatches, Revision } from './objects-model.mjs';

const $ = id => document.getElementById(id);
const portable = document.body.dataset.portable === 'true';
const revisions = new Revision();
let moduleValue = null, moduleApplied = false, instance = null, busy = false, aborter = null;
let map = null, saved = null, selectedRegion = null, example = null, fileRevision = 0, artifactFile = null;
const fmt = n => Number(n).toLocaleString('en-US');
const address = n => `0x${Number(n).toString(16)}`;
const node = (tag, text, className) => {
  const el = document.createElement(tag); if (text !== undefined) el.textContent = text;
  if (className) el.className = className; return el;
};
const live = () => moduleApplied && instance?.status === 'live';
function status(text, state = live() ? 'live' : '') { $('status-text').textContent = text; $('status').dataset.state = state; }
function clearError() { $('error').hidden = true; $('error').textContent = ''; }
function error(err) { $('error').textContent = `${err.code ? `${err.code}: ` : ''}${err.message || err}`; $('error').hidden = false; }
function clearEvidence() { $('result').hidden = true; $('result-empty').hidden = false; $('read-result').textContent = ''; }
function controls() {
  const yes = live() && !busy;
  for (const id of ['allocate','call','save-checkpoint','close','read']) $(id).disabled = !yes;
  $('close').disabled = !instance || busy;
  $('new-instance').disabled = !moduleApplied || busy;
  $('restore').disabled = !moduleApplied || !saved || saved.moduleId !== moduleValue?.id || busy;
  $('download-checkpoint').disabled = !saved || busy;
  // A retained prior checkpoint can recover a failed worker, but is never exported as current success.
  $('export').disabled = portable || !live() || busy;
  $('run-demo').disabled = !example || !moduleApplied || busy;
  $('release').disabled = !yes || region()?.kind !== 'buffer';
  $('cancel').disabled = !busy;
  $('example').disabled = busy || (portable && !moduleApplied);
  $('extract-module').disabled = portable || busy || !artifactFile;
  $('artifact-file').disabled = portable || busy;
  for(const el of document.querySelectorAll('.region')) el.disabled=busy;
  $('apply-module').disabled = busy;
  $('module-file').disabled = busy;
  $('checkpoint-file').disabled = busy;
  $('instance-id').textContent = instance ? `${instance.status} / ${instance.instanceId || 'starting'}` : 'No instance';
}
function edited(moduleEdit = false) {
  revisions.change(); clearEvidence();
  if (moduleEdit) {
    moduleApplied = false; example = null; $('example-guide').hidden = true;
    $('module-facts').textContent = 'Source edited. Apply and validate it before using these bytes.';
    $('contracts').replaceChildren(); $('chunks-wrap').hidden = true;
  }
  if (busy || moduleEdit) {
    aborter?.abort();
    const prior = instance; instance = null; prior?.close().catch(() => {});
    map = null; renderMap();
    status(moduleEdit ? 'Source edited. Apply it and create or restore an instance.' : 'Call inputs changed. Worker discarded; restore a prior checkpoint or create a new instance.', 'fault');
  } else status('Inputs edited. Previous call evidence is no longer current.');
  controls();
}
async function action(label, fn) {
  if (busy) return;
  clearError(); busy = true; aborter = new AbortController();
  const ticket = revisions.change(), signal = aborter.signal;
  clearEvidence();
  controls(); status(label);
  try {
    await fn({ ticket, signal, current: () => revisions.current(ticket) && !signal.aborted });
    if (revisions.current(ticket)) controls();
  } catch (err) {
    if (revisions.current(ticket)) {
      error(err); clearEvidence();
      status(instance?.status === 'poisoned' || signal.aborted ? 'Worker failed or was cancelled. Restore a prior checkpoint or create a new instance.' : 'Operation refused. Review the error and declared contract.', 'fault');
      if (!live()) { $('map-state').textContent = 'Previous memory observation is stale. This worker cannot produce successful state.'; $('region-detail').hidden = true; $('region-map').replaceChildren(); }
    }
  } finally { busy = false; aborter = null; controls(); }
}
function renderModule() {
  const m = moduleValue;
  $('module-facts').replaceChildren();
  const facts = node('div', undefined, 'facts');
  for (const [value, label] of [[Object.keys(m.entries).length,'ROOTS'],[m.chunks.length,'CHUNKS'],[m.chunks.reduce((n,c) => n+c.bytes.length/2,0),'BYTES']]) {
    const el = node('div'); el.append(node('strong',fmt(value)),node('span',label)); facts.append(el);
  }
  $('module-facts').append(facts,node('p',`MODULE ${m.id}\nARTIFACT ${m.artifactSHA256}\n${m.modelVersion}`, 'identity-box'));
  $('contracts').replaceChildren(); $('method').replaceChildren();
  for (const [name, entry] of Object.entries(m.entries)) {
    const card = node('div',undefined,'contract');
    card.append(node('strong',name),node('p',`${entry.root} @ ${address(entry.entry)}`),node('p',`(${entry.args.join(', ')}) → ${entry.return}`));
    $('contracts').append(card);
    const opt = node('option', name); opt.value = name; $('method').append(opt);
  }
  $('method').disabled = false; renderArgs();
  $('chunks-wrap').hidden = false; $('chunks').replaceChildren();
  for (const c of m.chunks) {
    const el = node('div',undefined,'chunk'), info = node('div', c.name || 'unnamed chunk');
    info.append(node('small',`${address(c.address)} · ${fmt(c.bytes.length/2)} bytes`));
    el.append(node('span',c.kind), info); $('chunks').append(el);
  }
  $('imports').textContent = JSON.stringify(m.imports,null,2);
  $('extraction').textContent = JSON.stringify(m.extraction || m.evidence || m.metadata || {},null,2);
}
async function applyModule(value, ctx) {
  const ticket = revisions.value;
  const old = instance; instance = null; await old?.close();
  if (!revisions.current(ticket)) return;
  moduleValue = structuredClone(value); moduleApplied = false; map = null; selectedRegion = null; clearEvidence(); renderMap();
  // Validation occurs inside the real runtime, in a new persistent worker.
  const created = await createModule(moduleValue, {signal:ctx.signal});
  if (!revisions.current(ticket)) { await created.close(); return; }
  instance = created; moduleApplied = true; $('module-json').value = JSON.stringify(moduleValue,null,2);
  renderModule(); await refresh(ticket); status('Module validated. Live worker ready; call a factory or allocate caller memory.'); controls();
}
function renderArgs(values = []) {
  $('args').replaceChildren();
  const entry = moduleValue?.entries?.[$('method').value];
  if (!entry || !moduleApplied) return;
  $('method-contract').textContent = `${entry.root} @ ${address(entry.entry)} · (${entry.args.join(', ')}) → ${entry.return} · caller-declared`;
  entry.args.forEach((type,index) => {
    const row = node('div',undefined,`arg ${type === 'reference' ? 'ref' : ''}`); row.append(node('span',`x${index} / ${type}`));
    if (type === 'reference') {
      const label = node('label','Owned region'), select = node('select'); select.dataset.index = index;
      select.id = `argument-${index}`; select.dataset.type = type;
      const nil = node('option','null'); nil.value = ''; select.append(nil);
      for (const r of map?.regions || []) { const opt = node('option',`${r.name} · ${r.id} · ${r.kind}`); opt.value = r.id; select.append(opt); }
      if (values[index]?.regionId) {
        if (!(map?.regions || []).some(r => r.id === values[index].regionId)) { const missing = node('option',`Missing region / ${values[index].regionId}`); missing.value = values[index].regionId; select.append(missing); }
        select.value = values[index].regionId;
      }
      label.append(select); row.append(label);
      const offsetLabel = node('label','Offset'), offset = node('input'); offset.type = 'number'; offset.min = '0'; offset.value = values[index]?.offset ?? 0; offset.id = `offset-${index}`;
      offsetLabel.append(offset); row.append(offsetLabel);
    } else {
      const label = node('label',`${type} decimal integer`), input = node('input'); input.id = `argument-${index}`; input.dataset.type = type;
      input.inputMode = 'numeric'; input.value = values[index] ?? '0'; label.append(input); row.append(label);
    }
    row.addEventListener('input', () => edited()); row.addEventListener('change', event => { if (event.target.tagName === 'SELECT') edited(); }); $('args').append(row);
  });
}
function argDraft() {
  return (moduleValue?.entries?.[$('method').value]?.args || []).map((type,index) => type === 'reference' ? {regionId:$(`argument-${index}`)?.value,offset:$(`offset-${index}`)?.value || 0} : $(`argument-${index}`)?.value);
}
function frozenArgs() {
  const draft = argDraft();
  return moduleValue.entries[$('method').value].args.map((type,index) => type === 'reference' ? (draft[index].regionId ? instance.reference(draft[index].regionId,integerArgument(draft[index].offset,'u32')) : null) : integerArgument(draft[index],type));
}
async function refresh(ticket) {
  const target = instance;
  if (!target || target.status !== 'live') return;
  const cp = await target.checkpoint();
  if (!revisions.current(ticket) || target !== instance) return;
  const previous = argDraft(); map = cp;
  for (const [id,key] of [['instructions','instructionLimit'],['trace-limit','traceLimit'],['timeout','timeoutMs']]) { if(cp.limits?.[key] !== undefined) { $(id).max=cp.limits[key]; $(id).value=Math.min(Number($(id).value),cp.limits[key]); } } renderMap(); renderArgs(previous); controls();
}
function region() { return map?.regions.find(r => r.id === selectedRegion); }
function renderMap() {
  $('region-map').replaceChildren();
  $('memory-total').textContent = `${fmt((map?.regions || []).reduce((n,r) => n+r.capacity,0))} bytes`;
  $('map-state').textContent = map ? `${map.regions.length} live regions · ${map.calls} native calls · ${fmt(map.totalInstructions)} lifetime instructions. Observed at the last completed operation.` : 'No live state. Heap fields remain opaque.';
  if (!map?.regions.length) $('region-map').append(node('div','No owned regions. Allocate a buffer or call a factory.','placeholder'));
  for (const r of map?.regions || []) {
    const button = node('button',undefined,'region'); button.type = 'button'; button.setAttribute('aria-pressed',String(selectedRegion === r.id));
    const line = node('div',undefined,'region-line'); line.append(node('span',`${r.name} / ${r.id}`),node('span',`${fmt(r.capacity)} B`));
    const known = initializedCount(r), strip = node('div',undefined,'region-strip');
    const good = node('span',undefined,r.kind === 'buffer' ? 'caller' : 'known'); good.style.width = `${r.capacity ? known/r.capacity*100 : 100}%`; strip.append(good);
    if (known < r.capacity) { const unknown = node('span',undefined,'unknown'); unknown.style.flex = '1'; strip.append(unknown); }
    button.append(line,node('small',`${r.kind} · ${r.access} · ${address(r.address)} · ${fmt(known)}/${fmt(r.capacity)} initialized`),strip);
    button.addEventListener('click', () => { selectedRegion = r.id; $('preview-offset').value = '0'; $('read-result').textContent = ''; renderMap(); controls(); }); $('region-map').append(button);
  }
  renderRegion();
}
function renderRegion() {
  const r = region(); $('region-detail').hidden = !r;
  if (!r) return;
  $('region-title').textContent = `${r.name} / ${r.id}`;
  $('region-meta').textContent = `${r.kind} · ${r.access} · [${address(r.address)}, ${address(r.address+r.capacity)}) · native read boundary ${fmt(r.readSize)} bytes`;
  const start = Math.min(r.capacity,Math.max(0,Number($('preview-offset').value) || 0));
  $('preview-offset').max = r.capacity; $('region-bytes').textContent = bytePreview(r,start);
}
function resultView(name,args,result,ticket) {
  if (!revisions.current(ticket)) return;
  $('result').hidden = false; $('result-empty').hidden = true;
  $('result-method').textContent = `${name} / COMPLETED IN ORIGINAL INSTRUCTIONS`;
  $('return-value').textContent = typeof result.returnValue === 'object' ? JSON.stringify(result.returnValue,null,2) : String(result.returnValue);
  $('result-binding').textContent = `Module ${moduleValue.id.slice(0,16)}… · instance ${instance.instanceId} · frozen input revision ${ticket}`;
  $('stats').replaceChildren();
  for (const [key,label] of [['instructions','instructions'],['readBytes','bytes read'],['writeBytes','bytes written'],['frees','heap frees']]) {
    const stat = node('div',undefined,'stat'); stat.append(node('strong',fmt(result.stats[key] ?? 0)),node('span',label)); $('stats').append(stat);
  }
  $('access-ranges').replaceChildren();
  for (const [id,r] of Object.entries(result.stats.regions || {})) {
    const el = node('div',undefined,'access'); el.append(node('strong',`${r.name} / ${id} / ${r.kind}`));
    for (const kind of ['read','write']) if (r[`${kind}Min`] !== undefined) el.append(node('span',`${kind}: [${address(r[`${kind}Min`])}, ${address(r[`${kind}Max`])}) · ${fmt(r[`${kind}Bytes`])} bytes · ${fmt(r[`${kind}s`])} accesses`));
    $('access-ranges').append(el);
  }
  if (!Object.keys(result.stats.regions || {}).length) $('access-ranges').append(node('p','No owned-region accesses recorded.','hint'));
  $('events-title').textContent = `Bounded memory events · ${result.trace.length} recorded / ${fmt(result.stats.traceEvents)} counted`;
  $('events').textContent = result.trace.length ? JSON.stringify(result.trace.slice(0,500),null,2)+(result.trace.length > 500 ? '\nPreview limited to 500 events; full events are included below.' : '') : 'Event recording disabled (trace limit 0). Memory counters and region intervals remain observed.';
  $('call-record').textContent = JSON.stringify({moduleId:moduleValue.id,instanceId:instance.instanceId,name,args,stats:result.stats,trace:result.trace},null,2);
  $('outputs').replaceChildren();
  for (const [outputName,hex] of Object.entries(result.outputs || {})) {
    const el = node('div',undefined,'output'); el.append(node('h3',`${outputName} · ${fmt(hex.length/2)} capacity bytes`),node('pre',hex.slice(0,1024)+(hex.length>1024?'\n… raw preview only':'')));
    const dl = node('button','Download raw bytes'); dl.addEventListener('click',() => { if (revisions.current(ticket) && live()) download(outputName+'.bin',Uint8Array.from(hex.match(/.{2}/g) || [],b => parseInt(b,16)),'application/octet-stream'); });
    el.append(dl); $('outputs').append(el);
  }
}
function download(name,bytes,type='application/json') {
  const url = URL.createObjectURL(new Blob([bytes],{type})), link = node('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
function checkpointFacts() {
  $('checkpoint-facts').textContent = saved ? `Saved module ${saved.moduleId.slice(0,16)}… · ${saved.regions.length} regions · ${saved.calls} calls. Origin ${saved.originInstanceId}. Restore keeps addresses and rebinds region references.` : 'No recovery checkpoint saved.';
}
async function newInstance(ctx,checkpoint) {
  const old = instance; instance = null; await old?.close();
  const created = await createModule(structuredClone(moduleValue),{...(checkpoint?{checkpoint:structuredClone(checkpoint)}:{}),signal:ctx.signal});
  if (!ctx.current()) { await created.close(); return; }
  instance = created; clearEvidence(); await refresh(ctx.ticket);
  status(checkpoint ? 'Restored into a fresh worker. Region addresses retained; references rebound to the new instance.' : 'New live instance. Call a factory or allocate caller memory.');
}


$('artifact-file').addEventListener('change',event => {
  edited(); artifactFile=event.target.files[0] || null;
  if(artifactFile?.size>32*1024*1024){error(new Error('Artifact is limited to 32 MiB.'));artifactFile=null;event.target.value='';}
  $('artifact-name').textContent=artifactFile?`${artifactFile.name} · ${fmt(artifactFile.size)} bytes · original source remains unchanged`:'No artifact selected.';controls();
});
$('declared-methods').addEventListener('input',() => edited());
$('extract-module').addEventListener('click',() => action('Extracting declared direct closures…',async ctx => {
  if(portable || !artifactFile)throw new Error('Choose an owned ARM64 artifact in the local extraction Studio.');
  const methods=JSON.parse($('declared-methods').value);
  if(!methods || Array.isArray(methods) || typeof methods!=='object' || !Object.keys(methods).length || Object.keys(methods).length>32)throw new Error('Declare between 1 and 32 named method contracts.');
  const bytes=new Uint8Array(await artifactFile.arrayBuffer());if(!ctx.current())return;
  const parts=[];for(let at=0;at<bytes.length;at+=32768)parts.push(String.fromCharCode(...bytes.subarray(at,at+32768)));
  const response=await fetch('/api/extract-module',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({artifact:btoa(parts.join('')),methods}),signal:ctx.signal});
  if(!response.ok){const text=await response.text();throw new Error(`Extraction refused (${response.status}): ${text.slice(0,600)}`);}
  const data=await response.json();if(!ctx.current())return;example=null;$('example-guide').hidden=true;
  artifactFile=null;$('artifact-file').value='';$('artifact-name').textContent='Extraction complete. Original artifact is no longer needed for execution.';
  await applyModule(data.module || data,ctx);
}));

$('module-json').addEventListener('input',() => edited(true));
$('apply-module').addEventListener('click',() => action('Validating module…',async ctx => { example = null; $('example-guide').hidden = true; await applyModule(JSON.parse($('module-json').value),ctx); }));
$('module-file').addEventListener('change',async event => {
  const file = event.target.files[0]; if (!file) return;
  edited(true); const ticket = revisions.value;
  try { if (file.size > 16*1024*1024) throw new Error('Module JSON is limited to 16 MiB.'); const text = await file.text(); if (!revisions.current(ticket)) return; $('module-json').value = text; await action('Importing module…',ctx => applyModule(JSON.parse(text),ctx)); } catch(err) { error(err); }
});
$('example').addEventListener('click',() => { if(portable) { if(moduleApplied) download('module.json',JSON.stringify(moduleValue,null,2)); return; } return action('Loading compiled LZ4 module and packets…',async ctx => {
  const response = await fetch('/api/object-example', {signal:ctx.signal}); if (!response.ok) throw new Error(`Example unavailable (${response.status}).`);
  const data = await response.json(); if(!ctx.current()) return; await applyModule(data.module,ctx);
  if (!ctx.current() || !moduleApplied) return; example = data; $('example-guide').hidden = false; $('demo-log').replaceChildren();
  $('example-context').textContent = JSON.stringify(data.nativeContext || data.context || {artifactSHA256:data.module.artifactSHA256,oracle:data.expected?.schema,platform:data.expected?.platform,mechanism:data.expected?.mechanism},null,2);
  status('Original LZ4 module loaded. Run its lifecycle or inspect and call the declared roots.');
}); });
$('new-instance').addEventListener('click',() => action('Creating fresh worker…',ctx => newInstance(ctx)));
$('close').addEventListener('click',() => action('Closing worker…',async () => { await instance?.close(); map=null; clearEvidence(); renderMap(); status('Worker closed. Restore a saved checkpoint or start a new instance.'); }));
$('save-checkpoint').addEventListener('click',() => action('Saving owned state…',async ctx => { const cp=await instance.checkpoint(); if (!ctx.current()) return; saved=cp; checkpointFacts(); status('Recovery checkpoint saved separately from later mutations.'); }));
$('download-checkpoint').addEventListener('click',() => { if(saved && !busy) download(`capsulith-${saved.moduleId.slice(0,12)}-checkpoint.json`,JSON.stringify(saved,null,2)); });
$('checkpoint-file').addEventListener('change',async event => {
  const file=event.target.files[0]; if(!file) return; const ticket=revisions.value;
  try { if(file.size>80*1024*1024) throw new Error('Checkpoint JSON is limited to 80 MiB.'); const cp=JSON.parse(await file.text()); if(!revisions.current(ticket)) return;
    if(cp.schema!=='capsulith.checkpoint.v1') throw new Error('Use a capsulith.checkpoint.v1 checkpoint.');
    if(!moduleApplied || cp.moduleId!==moduleValue.id) throw new Error('Checkpoint module identity does not match. Apply the matching module first.');
    saved=cp; checkpointFacts(); controls(); status('Checkpoint loaded for recovery. Restore will validate its digest, limits and owned regions.');
  } catch(err) { error(err); }
});
$('restore').addEventListener('click',() => action('Validating and restoring checkpoint…',ctx => newInstance(ctx,saved)));
$('export').addEventListener('click',() => action('Building source-bearing portable bundle…',async ctx => {
  const frozenModule=structuredClone(moduleValue); const cp=live()?await instance.checkpoint():undefined;
  const response=await fetch('/api/export-module',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({module:frozenModule,...(cp?{checkpoint:cp}:{})}),signal:ctx.signal});
  if(!response.ok){const text=await response.text();throw new Error(`Export refused (${response.status}): ${text.slice(0,300)}`);}
  const bytes=await response.blob(); if(!ctx.current()) return;
  const disposition=response.headers.get('Content-Disposition') || '', name=disposition.match(/filename="?([^";]+)"?/)?.[1] || 'capsulith-native-object.zip';
  download(name,bytes,'application/zip'); status('Portable source-bearing bundle downloaded with matching live state.');
}));
for(const id of ['buffer-name','buffer-access','buffer-capacity','buffer-hex','instructions','trace-limit','timeout']) $(id).addEventListener('input',() => { if(id==='buffer-hex') {fileRevision++; try{$('buffer-size').textContent=`${fmt(hexBytes($('buffer-hex').value).length/2)} supplied bytes`;}catch{$('buffer-size').textContent='Invalid hex pairs';}} edited(); });
$('buffer-file').addEventListener('change',async event => {
  const file=event.target.files[0];if(!file)return; edited(); const fileTicket=++fileRevision, ticket=revisions.value;
  try {if(file.size>16*1024*1024)throw new Error('Caller files are limited to 16 MiB.');const bytes=new Uint8Array(await file.arrayBuffer());if(fileTicket!==fileRevision || !revisions.current(ticket))return;
    $('buffer-hex').value=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');$('buffer-capacity').value=bytes.length;$('buffer-size').textContent=`${fmt(bytes.length)} supplied bytes · ${file.name}`;
  } catch(err){error(err);}
});
$('allocate').addEventListener('click',() => action('Allocating named caller memory…',async ctx => {
  const spec={name:$('buffer-name').value,access:$('buffer-access').value,capacity:integerArgument($('buffer-capacity').value,'u32'),bytes:hexBytes($('buffer-hex').value)};
  if(spec.bytes.length/2>spec.capacity)throw new Error('Supplied bytes exceed capacity.');
  const ref=await instance.allocateBuffer(spec);if(!ctx.current())return;selectedRegion=ref.regionId;clearEvidence();await refresh(ctx.ticket);status(`Allocated ${spec.name}. Use its owned reference in a declared method.`);
}));
$('method').addEventListener('change',() => {edited();renderArgs();});
$('call').addEventListener('click',() => action('Executing original method instructions…',async ctx => {
  const name=$('method').value,args=structuredClone(frozenArgs()),opts={instructionLimit:integerArgument($('instructions').value,'u32'),traceLimit:integerArgument($('trace-limit').value,'u32'),timeoutMs:integerArgument($('timeout').value,'u32'),signal:ctx.signal};
  clearEvidence(); const result=await instance.call(name,args,opts);if(!ctx.current())return;
  await refresh(ctx.ticket);resultView(name,args,result,ctx.ticket);status(`${name} completed. Owned state and access evidence reflect this call.`);
}));
$('cancel').addEventListener('click',() => {
  if(!busy) return;
  revisions.change(); clearEvidence(); aborter?.abort();
  const prior=instance; instance=null; prior?.close().catch(()=>{});
  map=null; renderMap(); controls();
  status('Cancelled. Worker discarded; restore a prior checkpoint or create a new instance.','fault');
});
$('preview-offset').addEventListener('input',() => { if(busy) edited(); $('read-result').textContent=''; renderRegion(); });
$('read-length').addEventListener('input',() => { if(busy) edited(); $('read-result').textContent=''; });
$('release').addEventListener('click',() => action('Releasing caller memory…',async ctx => {
  const r=region();if(!r || r.kind!=='buffer')throw new Error('Select a live caller buffer. Heap allocations must be freed by a declared native lifecycle method.');
  await instance.releaseBuffer(instance.reference(r.id));if(!ctx.current())return;selectedRegion=null;clearEvidence();await refresh(ctx.ticket);status(`Released ${r.name}. Any native pointer to it is now invalid.`);
}));
$('read').addEventListener('click',() => action('Checking actual readable bytes…',async ctx => {
  const r=region();if(!r)throw new Error('Select a live owned region.');const length=integerArgument($('read-length').value,'u32');if(length>4096)throw new Error('Inspection is limited to 4,096 bytes.');
  const offset=integerArgument($('preview-offset').value,'u32'),hex=await instance.readBuffer(instance.reference(r.id,offset),length);if(ctx.current()){$('read-result').textContent=hex;status(`Read ${length} initialized bytes through runtime access checks.`);}
}));

function demoStep(text, ctx) { if(!ctx.current()) return () => {};  const li=node('li',text);$('demo-log').append(li);return done=>{if(!ctx.current())return;li.dataset.state='done';li.textContent=done;}; }
async function demonstration(ctx) {
  const data=structuredClone(example); $('demo-log').replaceChildren();clearEvidence();
  if(!data?.packets?.first || !data?.packets?.second)throw new Error('Example packets are unavailable.');
  await newInstance(ctx);if(!ctx.current())return;
  let done=demoStep('Executing compiled factory…',ctx),made=await instance.call('create',[],{signal:ctx.signal});
  const heap=made.returnValue;if(!heap?.regionId)throw new Error('Factory did not return a live owned reference.');
  done(`Factory executed ${fmt(made.stats.instructions)} instructions; allocated ${fmt(made.stats.allocations.reduce((n,a)=>n+a.size,0))} heap bytes; bzero observed ${made.stats.imports.bzero || 0} times.`);
  await refresh(ctx.ticket);if(!ctx.current())return;
  const first=await instance.allocateBuffer({name:'first',access:'read',capacity:65536,bytes:data.packets.first});
  const destination=await instance.allocateBuffer({name:'destination',access:'readwrite',capacity:70000,bytes:''});
  done=demoStep('Compressing first 65,536 bytes…',ctx);
  const one=await instance.call('compress',[heap,first,destination,65536,70000,1],{traceLimit:0,signal:ctx.signal});
  if(!(one.returnValue>0)){await instance.close();throw new Error('LZ4 compression returned failure; start a new instance or restore prior state.');}
  done(`First block computed: ${fmt(one.returnValue)} compressed bytes from ${fmt(one.stats.instructions)} instructions.`);
  const dictionary=await instance.allocateBuffer({name:'savedHistory',access:'readwrite',capacity:65536,bytes:''});
  done=demoStep('Executing compiled saveDict before releasing input…',ctx);
  const dict=await instance.call('save',[heap,dictionary,65536],{traceLimit:0,signal:ctx.signal});
  if(dict.returnValue!==65536)throw new Error('Dictionary save did not retain the full input history.');
  await instance.releaseBuffer(first);done(`Compiled save retained ${fmt(dict.returnValue)} bytes; original input region explicitly released.`);
  if(!ctx.current())return;
  const checkpoint=await instance.checkpoint(),oldId=instance.instanceId,heapAddress=checkpoint.regions.find(r=>r.id===heap.regionId)?.address;
  saved=checkpoint;checkpointFacts();done=demoStep('Saving state and terminating the first worker…',ctx);await instance.close();
  await newInstance(ctx,checkpoint);if(!ctx.current())return;
  if(instance.instanceId===oldId || map.regions.find(r=>r.id===heap.regionId)?.address!==heapAddress)throw new Error('Restore did not create a fresh identity at the retained address.');
  done(`Fresh worker ${instance.instanceId.slice(0,12)}… restored heap at ${address(heapAddress)}. References rebound by region ID.`);
  const second=await instance.allocateBuffer({name:'second',access:'read',capacity:32768,bytes:data.packets.second});
  const reboundHeap=instance.reference(heap.regionId),reboundDestination=instance.reference(destination.regionId);
  done=demoStep('Continuing with unseen 32,768-byte packet…',ctx);
  const two=await instance.call('compress',[reboundHeap,second,reboundDestination,32768,70000,1],{traceLimit:0,signal:ctx.signal});
  if(!(two.returnValue>0)){await instance.close();throw new Error('LZ4 continuation returned failure; restore the saved pre-continuation checkpoint.');}
  done(`Continued block computed: ${fmt(two.returnValue)} compressed bytes; ${fmt(two.stats.regions[dictionary.regionId]?.readBytes || 0)} dictionary bytes read.`);
  await refresh(ctx.ticket);if(!ctx.current())return;resultView('compress after restore',[reboundHeap,second,reboundDestination,32768,70000,1],two,ctx.ticket);
  done=demoStep('Comparing computed output with independent native oracle…',ctx);
  const oracle=data.expected;
  if(oracle?.moduleID && oracle.moduleID!==moduleValue.id)throw new Error('Native comparison module identity mismatch.');
  if(!oracleMatches(one,oracle?.retained?.first) || !oracleMatches(two,oracle?.saved?.second))throw new Error('Computed output does not match both supplied native oracle blocks. No native equivalence claim is established.');
  done(`Native comparison verified: first ${fmt(one.returnValue)} B and restored continuation ${fmt(two.returnValue)} B match supplied oracle byte for byte.`);
  done=demoStep('Executing original freeStream lifecycle…',ctx);
  const freed=await instance.call('free',[reboundHeap],{signal:ctx.signal});
  await refresh(ctx.ticket);if(!ctx.current())return;
  if(map.regions.some(r=>r.id===heap.regionId) || freed.stats.frees!==1)throw new Error('Native free did not retire the owned heap region.');
  for(const r of [...map.regions])if(r.kind==='buffer')await instance.releaseBuffer(instance.reference(r.id));
  await refresh(ctx.ticket);if(!ctx.current())return;
  done(`Native free retired the heap (${fmt(freed.stats.instructions)} instructions). Caller buffers released; ${map.regions.length} live regions remain.`);
  // Result remains a historical frozen observation, clearly scoped to the completed sequence.
  $('result-binding').textContent += ' · observed before native free; lifecycle now complete';
  status('LZ4 lifecycle verified from computed results. Prior dictionary checkpoint remains available for recovery.');
}
$('run-demo').addEventListener('click',() => action('Running compiled LZ4 object lifecycle…',async ctx => {
  try { await demonstration(ctx); } catch(err) { if(ctx.current()) await instance?.close(); throw err; }
}));
window.addEventListener('pagehide',() => {aborter?.abort();instance?.close().catch(()=>{});});
controls();

if(portable) {
  $('example').textContent='Download module JSON';
  $('extract-local-note').hidden=false;
  $('declared-methods').disabled=true;
  $('export').textContent='Bundle already portable';
  $('export').title='Download module and saved checkpoint separately. This portable Studio has no export server.';
  for(const el of document.querySelectorAll('a[href="/studio/"]')) { el.href='#source-title'; el.textContent=el.classList.contains('brand')?'Capsulith · portable object':'Inspect bundled module'; }
  document.querySelector('a[aria-current]').href='./objects.html';
  $('example').disabled=true;
  action('Opening bundled module and owned state…',async ctx => {
    const response=await fetch('../portable.json',{signal:ctx.signal});
    if(!response.ok)throw new Error(`Portable module unavailable (${response.status}). Serve the bundle folder with its supplied local server.`);
    const data=await response.json();if(!ctx.current())return;
    let bundledModule=data.module, bundledCheckpoint=data.checkpoint;
    if(data.schema==='capsulith.portable.v1') {
      if(data.moduleFile!=='module.json' || ![null,'checkpoint.json'].includes(data.checkpointFile))throw new Error('Portable descriptor must reference its fixed bundled documents.');
      const read=async name=>{const r=await fetch('../'+name,{signal:ctx.signal});if(!r.ok)throw new Error(`Bundled document unavailable (${r.status}).`);return r.json();};
      bundledModule=await read('module.json');
      bundledCheckpoint=data.checkpointFile?await read('checkpoint.json'):null;
    }
    if(!ctx.current())return;await applyModule(bundledModule,ctx);
    if(!ctx.current())return;if(bundledCheckpoint){saved=structuredClone(bundledCheckpoint);checkpointFacts();await newInstance(ctx,saved);}
    if(data.exampleFile==='example.json') {
      const r=await fetch('../example.json',{signal:ctx.signal});if(!r.ok)throw new Error('Bundled example unavailable.');
      const demo=await r.json();if(!ctx.current())return;
      if(demo.module.id!==moduleValue.id)throw new Error('Bundled example module differs from imported instructions.');
      example=demo;$('example-guide').hidden=false;$('example-context').textContent=JSON.stringify(demo.nativeContext,null,2);
    }
    status(bundledCheckpoint?'Portable state restored with a fresh worker and rebound references.':'Portable module loaded. Create a native object using its declared factory.');
  });
}
