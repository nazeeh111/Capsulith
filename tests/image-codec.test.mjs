/* SPDX-License-Identifier: GPL-2.0-only */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {makeImageCodec,qoiHeader} from '../studio/image-codec-core.mjs';
const require = createRequire(import.meta.url);
const {createModule} = require('../runtime/objects.cjs');
const module = JSON.parse(fs.readFileSync(new URL('../examples/qoi/module.json',import.meta.url)));
const oracle = JSON.parse(fs.readFileSync(new URL('../examples/qoi/native-oracle.json',import.meta.url)));
const codec = makeImageCodec(createModule,module);
const bytes = value => Uint8Array.from(Buffer.from(value,'hex'));
for (const expected of oracle.cases) {
  test(`original QOI instructions match independent native/FFmpeg case ${expected.name}`,async()=>{
    const qoi = bytes(expected.qoiHex), rgba = bytes(expected.rgbaHex);
    const decoded = await codec.decodeQoi(qoi,{preserve:true});
    assert.equal(decoded.width,expected.width); assert.equal(decoded.height,expected.height);
    assert.deepEqual(decoded.rgba,rgba);
    assert.ok(decoded.stats.instructions > 0);
    assert.equal(decoded.stats.imports.malloc,1);
    const restored = await codec.restorePixels(decoded.preserved);
    assert.deepEqual(restored.rgba,rgba);
    assert.notEqual(restored.instanceId,decoded.instanceId);
    assert.equal(restored.freed,true);
    if (expected.channels === 4) {
      const encoded = await codec.encodePixels({width:expected.width,height:expected.height,rgba});
      assert.deepEqual(encoded.qoi,qoi);
      assert.ok(encoded.stats.instructions > 0);
      assert.equal(encoded.stats.imports.malloc,1);
    }
  });
}
test('header and RGBA shape bounds refuse before starting any worker',async()=>{
  let started = false;
  const refusing = makeImageCodec(()=>{started=true;throw Error('unexpected worker');},module);
  assert.throws(()=>qoiHeader(new Uint8Array(21)),/22 bytes/);
  const huge = bytes(oracle.cases[0].qoiHex); new DataView(huge.buffer).setUint32(4,257);
  await assert.rejects(refusing.decodeQoi(huge),/1–256/);
  await assert.rejects(refusing.encodePixels({width:1,height:1,rgba:new Uint8Array(3)}),/exactly/);
  assert.equal(started,false);
});
test('saved metadata binds native dimensions, region identities and CP digest',async()=>{
  const decoded = await codec.decodeQoi(bytes(oracle.cases[0].qoiHex),{preserve:true});
  const saved = decoded.preserved;
  await assert.rejects(codec.restorePixels({...saved,unknown:true}),/Invalid image/);
  // Same pixel count cannot silently change the geometry.
  await assert.rejects(codec.restorePixels({...saved,width:saved.height,height:saved.width}),/native descriptor/);
  await assert.rejects(codec.restorePixels({...saved,pixelRegionId:saved.descriptorRegionId}),/identities/);
  const altered = structuredClone(saved);
  const original = altered.checkpoint.regions[1].bytes;
  altered.checkpoint.regions[1].bytes = (original.slice(0,2)==='00'?'ff':'00')+original.slice(2);
  await assert.rejects(codec.restorePixels(altered),/digest/);
});
test('cancellation leaves no successful image result and a fresh operation works',async()=>{
  const bytesInput = bytes(oracle.cases[0].qoiHex);
  const controller = new AbortController();controller.abort();
  await assert.rejects(codec.decodeQoi(bytesInput,{signal:controller.signal}),/cancelled/);
  const controller2 = new AbortController();
  const pending = codec.decodeQoi(bytes(oracle.cases.find(c=>c.name==='maximum').qoiHex),{signal:controller2.signal});
  controller2.abort();
  await assert.rejects(pending,/cancel/i);
  const good = await codec.decodeQoi(bytesInput);
  assert.equal(good.width,17);
});
