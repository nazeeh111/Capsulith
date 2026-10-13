/* SPDX-License-Identifier: GPL-2.0-only */
import {createModule} from '../runtime/objects.mjs';
import {makeImageCodec} from './image-codec-core.mjs';
export {MAX_DIMENSION,MAX_FILE_BYTES,qoiHeader} from './image-codec-core.mjs';
let codec;
async function getCodec(signal) {
  if (!codec) {
    const response = await fetch(new URL('../examples/qoi/module.json',import.meta.url),{signal});
    if (!response.ok) throw new Error(`Native codec module could not load (${response.status}).`);
    codec = makeImageCodec(createModule,await response.json());
  }
  return codec;
}
export async function encodePixels(pixels,options={}) { return (await getCodec(options.signal)).encodePixels(pixels,options); }
export async function decodeQoi(bytes,options={}) { return (await getCodec(options.signal)).decodeQoi(bytes,options); }
export async function restorePixels(saved,options={}) { return (await getCodec(options.signal)).restorePixels(saved,options); }
