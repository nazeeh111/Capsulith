/* SPDX-License-Identifier: GPL-2.0-only */
export const MAX_DIMENSION = 256;
export const MAX_FILE_BYTES = 1048576;
const limits = {traceLimit: 0, timeoutMs: 30000, instructionLimit: 10000000};
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const unhex = value => Uint8Array.from(value.match(/../g) ?? [], b => parseInt(b, 16));
function check(value, message) { if (!value) throw new Error(message); }
function shape(width, height) {
  check(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 &&
    width <= MAX_DIMENSION && height <= MAX_DIMENSION, 'Image dimensions must be 1–256 pixels each.');
  return width * height * 4;
}
function cancelled(signal) { if (signal?.aborted) throw new Error('Image operation cancelled.'); }
export function qoiHeader(bytes) {
  check(bytes instanceof Uint8Array && bytes.length >= 22 && bytes.length <= MAX_FILE_BYTES,
    'QOI input must contain 22 bytes to 1 MiB.');
  check(bytes[0] === 113 && bytes[1] === 111 && bytes[2] === 105 && bytes[3] === 102, 'Expected a QOI file.');
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = v.getUint32(4), height = v.getUint32(8);
  shape(width, height);
  check([3,4].includes(bytes[12]) && bytes[13] <= 1, 'Unsupported QOI channel or colorspace header.');
  return {width, height, channels: bytes[12], colorspace: bytes[13]};
}
function descriptor(width, height) {
  const bytes = new Uint8Array(12), view = new DataView(bytes.buffer);
  view.setUint32(0, width, true); view.setUint32(4, height, true); bytes[8] = 4;
  return bytes;
}
function readDescriptor(bytes) {
  check(bytes.length === 12, 'Invalid native image descriptor.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, 12);
  const width = view.getUint32(0, true), height = view.getUint32(4, true);
  shape(width, height);
  check([3,4].includes(bytes[8]) && bytes[9] <= 1, 'Invalid native channel descriptor.');
  return {width, height};
}

// The factory allows Node tests to use the same functions with the Node worker.
// No codec is reimplemented here: qoiHeader only bounds allocation before calls.
export function makeImageCodec(createModule, module) {
  async function withInstance(options, action, checkpoint) {
    const signal = options?.signal;
    cancelled(signal);
    const instance = await createModule(module, {limits: checkpoint ? undefined : limits, checkpoint, signal});
    const abort = () => { void instance.close(); };
    signal?.addEventListener('abort', abort, {once:true});
    try { cancelled(signal); const result = await action(instance, signal); cancelled(signal); return result; }
    finally { signal?.removeEventListener('abort', abort); await instance.close(); }
  }
  return {
    async encodePixels({width, height, rgba}, options = {}) {
      const size = shape(width, height);
      check(rgba instanceof Uint8Array && rgba.length === size, 'RGBA bytes must exactly match the image dimensions.');
      return withInstance(options, async (instance, signal) => {
        const pixels = await instance.allocateBuffer({name:'pixels',access:'read',capacity:size,bytes:hex(rgba)});
        cancelled(signal);
        const desc = await instance.allocateBuffer({name:'descriptor',access:'read',capacity:12,bytes:hex(descriptor(width,height))});
        const length = await instance.allocateBuffer({name:'length',access:'readwrite',capacity:4,bytes:''});
        const result = await instance.call('encode', [pixels,desc,length], {signal});
        check(result.returnValue, 'The native QOI encoder refused this input.');
        const lengthBytes = unhex(await instance.readBuffer(length,4));
        const count = new DataView(lengthBytes.buffer).getInt32(0,true);
        check(count >= 22 && count <= size / 4 * 5 + 22, 'Native encoded length exceeds the declared bound.');
        const qoi = unhex(await instance.readBuffer(result.returnValue,count));
        qoiHeader(qoi);
        await instance.call('free',[result.returnValue],{signal});
        return {width,height,qoi,stats:result.stats,instanceId:instance.instanceId};
      });
    },
    async decodeQoi(bytes, options = {}) {
      const header = qoiHeader(bytes);
      return withInstance(options, async (instance, signal) => {
        const input = await instance.allocateBuffer({name:'qoi-input',access:'read',capacity:bytes.length,bytes:hex(bytes)});
        const desc = await instance.allocateBuffer({name:'qoi-descriptor',access:'readwrite',capacity:12,bytes:''});
        const result = await instance.call('decode',[input,bytes.length,desc,4],{signal});
        check(result.returnValue, 'The native QOI decoder refused this input.');
        const dimensions = readDescriptor(unhex(await instance.readBuffer(desc,12)));
        check(dimensions.width === header.width && dimensions.height === header.height, 'Native descriptor disagrees with the input header.');
        const rgba = unhex(await instance.readBuffer(result.returnValue,shape(header.width,header.height)));
        await instance.releaseBuffer(input);
        let preserved;
        if (options.preserve === true) {
          preserved = {schema:'capsulith.image.v1', ...dimensions,
            pixelRegionId:result.returnValue.regionId, descriptorRegionId:desc.regionId,
            checkpoint:await instance.checkpoint()};
        } else { await instance.call('free',[result.returnValue],{signal}); }
        return {...dimensions,rgba,stats:result.stats,instanceId:instance.instanceId,preserved};
      });
    },
    async restorePixels(saved, options = {}) {
      // Admit only the six documented fields before creating a worker.
      check(saved && Object.keys(saved).length === 6 &&
        ['schema','width','height','pixelRegionId','descriptorRegionId','checkpoint'].every(k=>Object.hasOwn(saved,k)) &&
        saved.schema === 'capsulith.image.v1', 'Invalid image preservation document.');
      const size = shape(saved.width,saved.height), regions = saved.checkpoint?.regions;
      check(Array.isArray(regions) && regions.length === 2, 'A preserved image must contain its pixel heap and native descriptor only.');
      const pixel = regions.find(r=>r?.id === saved.pixelRegionId), desc = regions.find(r=>r?.id === saved.descriptorRegionId);
      check(pixel?.kind === 'heap' && pixel.capacity === size && desc?.kind === 'buffer' &&
        desc.name === 'qoi-descriptor' && desc.capacity === 12, 'Preserved image region identities or sizes disagree.');
      return withInstance(options, async (instance, signal) => {
        const descriptorRef = instance.reference(saved.descriptorRegionId);
        const dimensions = readDescriptor(unhex(await instance.readBuffer(descriptorRef,12)));
        check(dimensions.width === saved.width && dimensions.height === saved.height, 'Saved dimensions disagree with the native descriptor.');
        const reference = instance.reference(saved.pixelRegionId);
        const rgba = unhex(await instance.readBuffer(reference,size));
        await instance.call('free',[reference],{signal});
        await instance.releaseBuffer(descriptorRef);
        const checkpoint = await instance.checkpoint();
        check(checkpoint.regions.length === 0, 'Native free did not retire the image allocation.');
        return {...dimensions,rgba,instanceId:instance.instanceId,freed:true};
      }, saved.checkpoint);
    }
  };
}
