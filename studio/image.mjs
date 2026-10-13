/* SPDX-License-Identifier: GPL-2.0-only */
import {encodePixels, decodeQoi, restorePixels, MAX_DIMENSION, MAX_FILE_BYTES} from './image-codec.mjs';

const $ = id => document.getElementById(id);
const number = value => Number(value).toLocaleString('en-US');
const STATE_LIMIT = 8 * 1024 * 1024;
let revision = 0, active = null, input = null, result = null, selection = {x:0,y:0};
const node = (tag,text,className) => {const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
function status(message,state='idle'){ $('status-text').textContent=message;$('status').dataset.state=state; }
function errorMessage(error){$('error').textContent=`${error.code ? error.code+': ' : ''}${error.message || error}`;$('error').hidden=false;}
function clearError(){$('error').hidden=true;$('error').textContent='';}
function controls(){
  $('run').disabled=!!active || !input || input.kind==='state';
  $('run').textContent=input?.kind==='png'?'Encode & verify pixels →':'Decode original instructions →';
  $('cancel').disabled=!active;
  $('download-qoi').disabled=!!active || !result?.qoi;
  $('download-png').disabled=!!active || !result;
  $('download-state').disabled=!!active || !result?.preserved;
  $('restore').disabled=!!active || !result?.preserved;
  for(const id of ['pixel-x','pixel-y'])$(id).disabled=!(result || input?.pixels);
}
function showCanvas(id,pixels){
  const canvas=$(id);canvas.width=pixels.width;canvas.height=pixels.height;
  const context=canvas.getContext('2d');
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels.rgba),pixels.width,pixels.height),0,0);
  canvas.hidden=false;$(id==='source-canvas'?'source-empty':'result-empty').hidden=true;
  const scale=Number($('zoom').value);canvas.style.width=`${pixels.width*scale}px`;canvas.style.height=`${pixels.height*scale}px`;
}
function hideCanvas(id){$(id).hidden=true;$(id).width=1;$(id).height=1;$(id==='source-canvas'?'source-empty':'result-empty').hidden=false;}
function clearOutput(){
  result=null;hideCanvas('result-canvas');
  if(input?.kind!=='png'){hideCanvas('source-canvas');$('source-caption').textContent='Awaiting successful compiled decode or validated state restoration.';}
  $('comparison').hidden=true;$('preserved-facts').hidden=true;$('restored-instance').textContent='Not restored';
  $('preserve-status').textContent='A successful decode captures the pixel heap for this explicit recovery path.';
  $('result-caption').textContent='Native output appears after execution.';$('result-format').textContent='RGBA / NATIVE';
  $('output-size').textContent='No output bytes yet';$('evidence-summary').replaceChildren();$('evidence-empty').hidden=false;
  $('evidence-details').hidden=true;$('stats').textContent='';$('bytes-details').hidden=true;$('byte-preview').textContent='';
  renderPixel();controls();
}
function resetInput(){
  active?.controller.abort();active=null;revision++;input=null;clearOutput();hideCanvas('source-canvas');clearError();
  $('source-name').textContent='NO IMAGE SELECTED';$('source-size').textContent='PNG / QOI · ≤256 × 256 · ≤1 MiB';
  $('source-title').textContent='Source image';$('source-format').textContent='WAITING';$('source-caption').textContent='No image has been decoded.';
  selection={x:0,y:0};renderPixel();controls();
}
async function task(message,fn){
  active?.controller.abort();
  const operation={ticket:++revision,controller:new AbortController()};active=operation;clearError();clearOutput();status(message,'busy');controls();
  const current=()=>active===operation && revision===operation.ticket && !operation.controller.signal.aborted;
  try {await fn({signal:operation.controller.signal,current,ticket:operation.ticket});}
  catch(error){if(active===operation && revision===operation.ticket){clearOutput();errorMessage(error);status(operation.controller.signal.aborted?'Stopped. No successful image or preserved state was retained.':'Image operation refused. Review the error before trying again.','error');}}
  finally{if(active===operation){active=null;controls();}}
}
function pngHeader(bytes){
  if(bytes.length<33 || bytes.length>MAX_FILE_BYTES)throw new Error('PNG input must contain a complete IHDR header and be at most 1 MiB.');
  const signature=[137,80,78,71,13,10,26,10];
  if(!signature.every((value,index)=>bytes[index]===value))throw new Error('Expected a PNG file signature.');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(view.getUint32(8)!==13 || String.fromCharCode(...bytes.subarray(12,16))!=='IHDR')throw new Error('PNG must begin with a 13-byte IHDR chunk.');
  const width=view.getUint32(16),height=view.getUint32(20);
  if(!width || !height || width>MAX_DIMENSION || height>MAX_DIMENSION)throw new Error(`PNG dimensions must be 1–${MAX_DIMENSION} pixels each; found ${width} × ${height}.`);
  return {width,height};
}
function qoiSignature(bytes){return bytes.length>=4 && bytes[0]===113 && bytes[1]===111 && bytes[2]===105 && bytes[3]===102;}
async function browserPng(bytes,ctx){
  // Bound IHDR dimensions before asking browser image APIs to allocate pixels.
  const shape=pngHeader(bytes),bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}),{colorSpaceConversion:'none',premultiplyAlpha:'none'});
  try{
    if(!ctx.current())return null;
    if(bitmap.width!==shape.width || bitmap.height!==shape.height)throw new Error('Browser PNG dimensions disagree with IHDR.');
    const canvas=document.createElement('canvas');canvas.width=shape.width;canvas.height=shape.height;
    const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(bitmap,0,0);
    return {...shape,rgba:new Uint8Array(context.getImageData(0,0,shape.width,shape.height).data)};
  } finally{bitmap.close();}
}
function inputFacts(){
  $('source-name').textContent=input.name;
  $('source-size').textContent=`${input.kind.toUpperCase()} · ${number(input.fileBytes)} file bytes${input.pixels?` · ${input.pixels.width} × ${input.pixels.height}`:''}`;
  $('source-format').textContent=input.kind==='png'?'PNG / BROWSER':input.kind==='qoi'?'QOI / COMPILED':'CHECKPOINT / NATIVE';
  $('journey-label').textContent=input.kind==='png'?'01 / PNG → COMPILED QOI ENCODE → FRESH DECODE':input.kind==='qoi'?'01 / QOI → ORIGINAL COMPILED DECODER':'01 / SAVED HEAP → FRESH WORKER → NATIVE FREE';
  $('journey-note').textContent=input.kind==='png'?'Compare native returned RGBA against the browser-imported source bytes.':input.kind==='qoi'?'QOI pixels come from original compiled decoder instructions.':'Saved region bytes are validated and read through the actual runtime.';
}
function equalBytes(left,right){if(left.length!==right.length)return false;for(let i=0;i<left.length;i++)if(left[i]!==right[i])return false;return true;}
function pixelShape(value){
  if(!Number.isInteger(value.width)||!Number.isInteger(value.height)||value.width<1||value.height<1||value.width>MAX_DIMENSION||value.height>MAX_DIMENSION||!(value.rgba instanceof Uint8Array)||value.rgba.length!==value.width*value.height*4)throw new Error('Native pixel result does not match the bounded image shape.');
}
function comparison(title,detail,state='success'){
  $('comparison').hidden=false;$('comparison').dataset.state=state;$('comparison-icon').textContent=state==='success'?'✓':'!';
  $('comparison-title').textContent=title;$('comparison-detail').textContent=detail;$('pixel-count').textContent=`${number(result.width*result.height)} pixels`;
}
function nativeEvidence(records){
  $('evidence-summary').replaceChildren();$('evidence-empty').hidden=records.length>0;
  for(const record of records){
    const el=node('div',undefined,'summary');el.append(node('strong',record.label));
    if(Number.isSafeInteger(record.stats?.instructions))el.append(node('span',`${number(record.stats.instructions)} original instructions`));
    el.append(node('span',`Instance ${record.instanceId}`));if(record.freed===true)el.append(node('span','Native free completed; restored owned regions retired.'));
    $('evidence-summary').append(el);
  }
  $('stats').textContent=JSON.stringify(records,null,2);$('evidence-details').hidden=!records.some(record=>record.stats);
}
function preservedFacts(preserved,restore){
  $('preserved-facts').hidden=!preserved;if(!preserved)return;
  const region=preserved.checkpoint.regions.find(value=>value.id===preserved.pixelRegionId);
  $('original-instance').textContent=preserved.checkpoint.originInstanceId;
  $('pixel-region').textContent=`${preserved.pixelRegionId} · ${number(region.capacity)} B · 0x${region.address.toString(16)}`;
  $('restored-instance').textContent=restore?.instanceId || 'Not restored';
  $('free-state').textContent=restore?.freed?'Native free completed; zero restored owned regions':'Pixel heap + descriptor saved; original worker closed';
  $('preserve-status').textContent=restore?.freed?'Actual restored pixels are displayed. Native free retired the restored allocation; this saved document can create another fresh instance.':'Native pixel heap and descriptor checkpoint captured. Original decoder worker closed; original QOI input region released.';
}
function publish(value,ctx){
  if(!ctx.current())return;
  pixelShape(value);result={...value,revision:ctx.ticket};showCanvas('result-canvas',value);
  if(input.kind==='png')$('source-caption').textContent=`${input.pixels.width} × ${input.pixels.height} · browser-imported RGBA · retained comparison source`;
  if(input.kind!=='png'){showCanvas('source-canvas',value);$('source-title').textContent=input.kind==='state'?'Reopened image':'Native decoded source';$('source-caption').textContent=input.kind==='state'?'Pixels read from the validated saved native allocation.':'Source QOI decoded by original compiled instructions; no browser QOI decoder.';}
  $('result-caption').textContent=`${value.width} × ${value.height} · ${number(value.rgba.length)} returned RGBA bytes · worker closed`;
  $('result-format').textContent=value.restored?'RGBA / RESTORED':'RGBA / NATIVE';
  $('output-size').textContent=value.qoi?`${number(value.qoi.length)} QOI bytes · ${number(value.rgba.length)} RGBA bytes`:`${number(value.rgba.length)} RGBA bytes · preserved input`;
  nativeEvidence(value.records || []);preservedFacts(value.preserved,value.restored);
  $('bytes-details').hidden=!value.qoi;
  if(value.qoi)$('byte-preview').textContent=Array.from(value.qoi.subarray(0,64),byte=>byte.toString(16).padStart(2,'0')).join(' ');
  selection={x:Math.floor(value.width/2),y:Math.floor(value.height/2)};renderPixel();controls();
}
async function runCodec(ctx){
  const frozen=input.kind==='png'?{...input,pixels:{...input.pixels,rgba:new Uint8Array(input.pixels.rgba)}}:{...input,bytes:new Uint8Array(input.bytes)};
  let qoi=frozen.bytes,encoded;
  if(frozen.kind==='png'){
    status('Executing original QOI encoder instructions…','busy');encoded=await encodePixels(frozen.pixels,{signal:ctx.signal});
    if(!ctx.current())return;qoi=encoded.qoi;status('Encoder ended. Decoding its bytes in a fresh native worker…','busy');
  }
  const decoded=await decodeQoi(qoi,{signal:ctx.signal,preserve:true});if(!ctx.current())return;
  pixelShape(decoded);
  if(encoded && (encoded.instanceId===decoded.instanceId || !equalBytes(frozen.pixels.rgba,decoded.rgba)))throw new Error('Fresh compiled decode did not reproduce every source RGBA byte. No successful output is available.');
  if(!decoded.preserved)throw new Error('The native decoder did not return a preserved image allocation.');
  const records=[...(encoded?[{label:'Compiled QOI encode',stats:encoded.stats,instanceId:encoded.instanceId}]:[]),{label:'Compiled QOI decode',stats:decoded.stats,instanceId:decoded.instanceId}];
  publish({...decoded,qoi:new Uint8Array(qoi),records},ctx);
  if(!ctx.current())return;
  comparison(encoded?'Every RGBA byte matches.':'QOI decoded in original instructions.',encoded?`${number(decoded.rgba.length)} bytes compared with browser-imported source. Encoder and decoder used separate worker identities.`:'Actual native decoder pixels are displayed. No independent source-pixel comparison is claimed for a QOI-only input.');
  status(encoded?'Encode → fresh decode verified. Every source RGBA byte matches; native image state preserved.':'Compiled QOI decode completed. Pixel heap preserved; original worker closed.','success');
}
async function loadImage(file){
  resetInput();
  await task('Reading image bytes…',async ctx=>{
    if(file.size>MAX_FILE_BYTES)throw new Error('PNG/QOI files are limited to 1 MiB.');
    const bytes=new Uint8Array(await file.arrayBuffer());if(!ctx.current())return;
    if(qoiSignature(bytes)){
      input={kind:'qoi',bytes,name:file.name,fileBytes:bytes.length};inputFacts();status('QOI ready. Run the compiled decoder to view its actual pixels.');
      $('source-caption').textContent='QOI source bytes loaded; native decode has not run.';
    }else{
      const pixels=await browserPng(bytes,ctx);if(!ctx.current()||!pixels)return;
      input={kind:'png',pixels,name:file.name,fileBytes:bytes.length};inputFacts();showCanvas('source-canvas',pixels);
      $('source-caption').textContent=`${pixels.width} × ${pixels.height} · browser-imported RGBA · awaiting native encode/decode comparison`;
      status('PNG pixels ready. Run original encoder and fresh decoder to verify all RGBA bytes.');renderPixel();
    }
  });
}
async function reopenState(file){
  resetInput();
  await task('Validating and reopening preserved image…',async ctx=>{
    if(file.size>STATE_LIMIT)throw new Error('Preserved image JSON is limited to 8 MiB.');
    const saved=JSON.parse(await file.text());if(!ctx.current())return;
    const restored=await restorePixels(saved,{signal:ctx.signal});if(!ctx.current())return;
    if(restored.freed!==true || restored.instanceId===saved.checkpoint?.originInstanceId)throw new Error('Restore did not establish a fresh instance and completed native free.');
    input={kind:'state',name:file.name,fileBytes:file.size};inputFacts();
    publish({...restored,preserved:saved,restored,records:[{label:'Saved pixel allocation restored',instanceId:restored.instanceId,freed:restored.freed}]},ctx);
    comparison('Saved pixels reopened. Native allocation freed.','The matching module and checkpoint were validated by the runtime. This saved document is state, not authenticated image provenance.');
    status('Preserved image reopened in a fresh worker. Actual pixel bytes read; native free completed.','success');
  });
}
function selectedPixels(){return result || input?.pixels;}
function renderPixel(){
  const pixels=selectedPixels();
  if(!pixels){$('loupe').hidden=true;$('loupe-empty').hidden=false;for(const id of ['red','green','blue','alpha'])$(id).textContent='—';$('pixel-value').textContent='No pixel selected';$('pixel-swatch').style.background='transparent';return;}
  selection.x=Math.max(0,Math.min(pixels.width-1,Math.trunc(selection.x)||0));selection.y=Math.max(0,Math.min(pixels.height-1,Math.trunc(selection.y)||0));
  $('pixel-x').value=selection.x;$('pixel-x').max=pixels.width-1;$('pixel-y').value=selection.y;$('pixel-y').max=pixels.height-1;
  const offset=(selection.y*pixels.width+selection.x)*4,rgba=pixels.rgba.subarray(offset,offset+4);
  for(const [index,id]of ['red','green','blue','alpha'].entries())$(id).textContent=rgba[index];
  $('pixel-swatch').style.background=`rgba(${rgba[0]},${rgba[1]},${rgba[2]},${rgba[3]/255})`;
  $('pixel-value').textContent=`(${selection.x}, ${selection.y}) · byte ${offset} · ${Array.from(rgba,b=>b.toString(16).padStart(2,'0')).join(' ')} · ${result?'native returned':'browser source'}`;
  const canvas=$('loupe'),context=canvas.getContext('2d');context.clearRect(0,0,180,180);
  const cell=20;
  for(let row=0;row<9;row++)for(let col=0;col<9;col++){
    context.fillStyle=(row+col)%2?'#e2e8d7':'#f5f7ee';context.fillRect(col*cell,row*cell,cell,cell);
    const x=selection.x+col-4,y=selection.y+row-4;
    if(x>=0&&x<pixels.width&&y>=0&&y<pixels.height){const at=(y*pixels.width+x)*4;context.fillStyle=`rgba(${pixels.rgba[at]},${pixels.rgba[at+1]},${pixels.rgba[at+2]},${pixels.rgba[at+3]/255})`;context.fillRect(col*cell,row*cell,cell,cell);}
  }
  context.strokeStyle='#fff';context.lineWidth=3;context.strokeRect(80.5,80.5,19,19);context.strokeStyle='#242b22';context.lineWidth=1;context.strokeRect(80.5,80.5,19,19);
  canvas.hidden=false;$('loupe-empty').hidden=true;canvas.setAttribute('aria-label',`Nine by nine ${result?'native returned':'browser source'} pixel neighborhood, centered at ${selection.x}, ${selection.y}. R ${rgba[0]}, G ${rgba[1]}, B ${rgba[2]}, alpha ${rgba[3]}.`);
}
function inspectCanvas(event,canvas){
  const pixels=canvas.id==='source-canvas'?(input?.pixels || result):result;if(!pixels)return;
  const rect=canvas.getBoundingClientRect();
  selection={x:Math.floor((event.clientX-rect.left)*pixels.width/rect.width),y:Math.floor((event.clientY-rect.top)*pixels.height/rect.height)};renderPixel();
}
for(const id of ['source-canvas','result-canvas']){
  $(id).addEventListener('click',event=>inspectCanvas(event,$(id)));
  $(id).addEventListener('keydown',event=>{
    if(!selectedPixels())return;const movement={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
    if(movement){event.preventDefault();selection.x+=movement[0];selection.y+=movement[1];renderPixel();}
    if(event.key==='Home'){event.preventDefault();selection={x:0,y:0};renderPixel();}
    if(event.key==='End'){event.preventDefault();selection={x:selectedPixels().width-1,y:selectedPixels().height-1};renderPixel();}
  });
}
for(const [id,key]of [['pixel-x','x'],['pixel-y','y']])$(id).addEventListener('input',()=>{selection[key]=Number($(id).value);renderPixel();});
$('zoom').addEventListener('change',()=>{if(input?.pixels)showCanvas('source-canvas',input.pixels);else if(result)showCanvas('source-canvas',result);if(result)showCanvas('result-canvas',result);});
$('image-file').addEventListener('change',event=>{const file=event.target.files[0];if(file)void loadImage(file);event.target.value='';});
$('state-file').addEventListener('change',event=>{const file=event.target.files[0];if(file)void reopenState(file);event.target.value='';});
$('run').addEventListener('click',()=>{if(input && !active)void task('Running original compiled codec…',runCodec);});
$('example').addEventListener('click',()=>{
  resetInput();void task('Loading original Orbit QOI artwork…',async ctx=>{
    const response=await fetch(new URL('../examples/qoi/orbit.qoi',import.meta.url),{signal:ctx.signal});if(!response.ok)throw new Error(`Example could not load (${response.status}).`);
    const length=Number(response.headers.get('Content-Length'));if(length>MAX_FILE_BYTES)throw new Error('Example exceeds the input size bound.');
    const bytes=new Uint8Array(await response.arrayBuffer());if(!ctx.current())return;if(bytes.length>MAX_FILE_BYTES)throw new Error('Example exceeds 1 MiB.');
    input={kind:'qoi',name:'Orbit · original artwork',bytes,fileBytes:bytes.length};inputFacts();await runCodec(ctx);
  });
});
$('restore').addEventListener('click',()=>{
  if(active || !result?.preserved)return;
  const saved=structuredClone(result.preserved),expected=new Uint8Array(result.rgba),qoi=result.qoi?new Uint8Array(result.qoi):undefined,records=result.records || [];
  void task('Restoring actual native image allocation in a fresh worker…',async ctx=>{
    const restored=await restorePixels(saved,{signal:ctx.signal});if(!ctx.current())return;
    if(restored.freed!==true || restored.instanceId===saved.checkpoint.originInstanceId || !equalBytes(expected,restored.rgba))throw new Error('Restored pixels or fresh-instance/native-free evidence did not match the preserved image.');
    publish({...restored,qoi,preserved:saved,restored,records:[...records,{label:'Fresh heap restoration and native free',instanceId:restored.instanceId,freed:true}]},ctx);
    comparison('Restored pixels match. Native allocation freed.',`${number(expected.length)} RGBA bytes compared with the prior native output. Fresh instance identity; original free instructions retired restored regions.`);
    status('Fresh restore verified every pixel byte. Native image heap freed and worker closed.','success');
  });
});
$('cancel').addEventListener('click',()=>{
  if(!active)return;active.controller.abort();active=null;revision++;clearOutput();clearError();status('Stopped. Late results are discarded; no successful image state is available.','error');controls();
});
function download(name,bytes,type){const url=URL.createObjectURL(new Blob([bytes],{type})),link=node('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function basename(){return (input?.name || 'capsulith-image').replace(/\.[^.]+$/,'').replace(/[^A-Za-z0-9_-]+/g,'-').slice(0,60) || 'capsulith-image';}
$('download-qoi').addEventListener('click',()=>{if(result?.qoi && !active)download(`${basename()}.qoi`,result.qoi,'application/octet-stream');});
$('download-state').addEventListener('click',()=>{if(result?.preserved && !active){const json=JSON.stringify(result.preserved,null,2);if(new TextEncoder().encode(json).length>STATE_LIMIT){errorMessage(new Error('Preserved JSON exceeds 8 MiB.'));return;}download(`${basename()}.image.json`,json,'application/json');}});
$('download-png').addEventListener('click',async()=>{
  if(!result || active)return;const frozen=result,ticket=revision;
  const canvas=document.createElement('canvas');canvas.width=frozen.width;canvas.height=frozen.height;canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(frozen.rgba),frozen.width,frozen.height),0,0);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(revision!==ticket || result!==frozen || active)return;
  if(!blob){errorMessage(new Error('Browser PNG export failed.'));return;}download(`${basename()}.png`,blob,'image/png');
});
window.addEventListener('pagehide',()=>{active?.controller.abort();active=null;revision++;});
controls();

// Source-bearing image bundles and the static public demo have no function server.
if(document.body.dataset.imagePortable==='true'){
  document.querySelector('.brand').setAttribute('href','./image.html');
  const sourceLink=document.querySelector('nav a[href="./index.html"]');
  sourceLink.textContent='Source ↗';sourceLink.href='https://github.com/nazeeh111/Capsulith';sourceLink.target='_blank';sourceLink.rel='noopener';
  for(const link of document.querySelectorAll('a[href="./objects.html"]')){
    link.href='https://nazeeh111.github.io/Capsulith/studio/objects.html';link.target='_blank';link.rel='noopener';
    if(link.closest('nav'))link.textContent='Objects ↗';
  }
}
