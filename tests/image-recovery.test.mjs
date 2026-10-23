/* SPDX-License-Identifier: GPL-2.0-only */
// Exercise the shipped controller; layout and real worker restoration are checked separately.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function harness(restorePixels=async()=>{throw new Error('Checkpoint digest mismatch');}) {
  const elements=new Map();
  const drawing={clearRect(){},fillRect(){},strokeRect(){},putImageData(){}};
  const el=id=>{if(!elements.has(id))elements.set(id,{value:'2',textContent:'',hidden:false,disabled:false,dataset:{},style:{},listeners:{},children:[],addEventListener(name,fn){this.listeners[name]=fn;},replaceChildren(){this.children=[];},getContext(){return drawing;},setAttribute(){}});return elements.get(id);};
  const context=vm.createContext({console,AbortController,Uint8Array,Uint8ClampedArray,TextEncoder,Blob,URL,structuredClone,setTimeout,clearTimeout,MAX_DIMENSION:256,MAX_FILE_BYTES:1048576,restorePixels,window:{addEventListener(){}},document:{getElementById:el,body:{dataset:{}},createElement:()=>({})}});
  let source=fs.readFileSync(new URL('../studio/image.mjs',import.meta.url),'utf8').replace(/^import[^\n]+\n/m,'').replaceAll('import.meta.url',JSON.stringify(import.meta.url));
  source+='\nglobalThis.api={reopenState,task,seed(){input={kind:"state",name:"prior.image.json"};result={width:1,height:1,rgba:new Uint8Array([1,2,3,255]),preserved:{schema:"prior"}};},state(){return {input,result,active};}};';
  vm.runInContext(source,context);context.api.seed();el('result-caption').textContent='Prior valid image';return {api:context.api,el};
}
test('malformed, oversized and rejected saved images preserve prior pixels and downloads',async()=>{
  const {api,el}=harness();const prior=api.state().result;
  for(const file of [{size:4,text:async()=>'{bad'},{size:8388609,text:async()=>{throw Error('Oversized file must not be read');}},{size:2,text:async()=>'{}'}]){
    await api.reopenState(file);
    assert.equal(api.state().result,prior);assert.equal(el('result-caption').textContent,'Prior valid image');assert.equal(el('download-state').disabled,false);assert.match(el('status-text').textContent,/prior image and saved state remain available/);assert.equal(el('error').hidden,false);
  }
});
test('cancelled restore retains prior output and excludes a late worker result',async()=>{
  let resolve;const {api,el}=harness(()=>new Promise(r=>{resolve=r;}));const prior=api.state().result;
  const pending=api.reopenState({size:2,text:async()=>'{}'});await new Promise(r=>setImmediate(r));
  el('cancel').listeners.click();resolve({width:1,height:1,rgba:new Uint8Array([9,8,7,255]),freed:true,instanceId:'fresh'});await pending;
  assert.equal(api.state().result,prior);assert.equal(el('result-caption').textContent,'Prior valid image');assert.equal(el('download-state').disabled,false);assert.match(el('status-text').textContent,/Restore stopped/);
});
