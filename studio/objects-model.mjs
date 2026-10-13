/* SPDX-License-Identifier: GPL-2.0-only */
export function hexBytes(text) {
  const hex = String(text).replace(/\s/g, '').toLowerCase();
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error('Use complete hex byte pairs, such as 0a ff.');
  return hex;
}
export function integerArgument(text, type) {
  if (!/^[+-]?\d+$/.test(String(text).trim())) throw new Error(`${type} needs a decimal integer.`);
  const n = BigInt(String(text).trim()), bits = BigInt(type.slice(1));
  const signed = type.startsWith('i');
  const low = signed ? -(1n << (bits - 1n)) : 0n;
  const high = (1n << (signed ? bits - 1n : bits)) - 1n;
  if (n < low || n > high) throw new Error(`${type} is outside its ${bits}-bit range.`);
  return bits === 64n ? n.toString() : Number(n);
}
export function bytePreview(region, start = 0, count = 128) {
  const rows = [];
  for (let offset = start; offset < Math.min(region.capacity, start + count); offset += 16) {
    const values = [];
    for (let n = offset; n < Math.min(region.capacity, offset + 16, start + count); n++) {
      const known = !region.initialized || region.initialized.slice(n * 2, n * 2 + 2) === '01';
      values.push(known ? region.bytes.slice(n * 2, n * 2 + 2) : '??');
    }
    rows.push(`${offset.toString(16).padStart(8, '0')}  ${values.join(' ')}`);
  }
  return rows.join('\n');
}
export function initializedCount(region) {
  if (!region.initialized) return region.capacity;
  let count = 0;
  for (let n = 0; n < region.initialized.length; n += 2) if (region.initialized.slice(n, n + 2) === '01') count++;
  return count;
}
export function oracleMatches(result, oracle, outputName = 'destination') {
  return !!oracle && Number.isSafeInteger(result.returnValue) && result.returnValue > 0 &&
    result.returnValue === oracle.return &&
    result.outputs?.[outputName]?.slice(0, result.returnValue * 2) === oracle.hex;
}
// Every async publication must still belong to the input revision that started it.
export class Revision {
  value = 0;
  change() { return ++this.value; }
  current(ticket) { return ticket === this.value; }
}
