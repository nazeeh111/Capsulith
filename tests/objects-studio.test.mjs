/* SPDX-License-Identifier: GPL-2.0-only */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hexBytes, integerArgument, bytePreview, initializedCount, oracleMatches, Revision } from '../studio/objects-model.mjs';

test('typed integers preserve all 64-bit bits and reject unsigned/signed overflow', () => {
  assert.equal(integerArgument('18446744073709551615','u64'),'18446744073709551615');
  assert.equal(integerArgument('-9223372036854775808','i64'),'-9223372036854775808');
  assert.equal(integerArgument('-2147483648','i32'),-2147483648);
  for(const [text,type] of [['18446744073709551616','u64'],['-1','u32'],['2147483648','i32'],['1.5','i32'],['1e3','u32']]) assert.throws(()=>integerArgument(text,type));
});
test('opaque heap preview never renders poison bytes as initialized state', () => {
  const r={capacity:4,bytes:'00aa11ff',initialized:'01000100'};
  assert.equal(bytePreview(r),'00000000  00 ?? 11 ??');
  assert.equal(initializedCount(r),2);
  assert.equal(bytePreview(r,2,1),'00000002  11');
  assert.equal(initializedCount({capacity:4,bytes:'00000000'}),4);
});
test('hex file input normalization rejects incomplete and non-hex bytes', () => {
  assert.equal(hexBytes('AA 01\nff'),'aa01ff');
  assert.throws(()=>hexBytes('aa1')); assert.throws(()=>hexBytes('00 zz'));
});
test('native equivalence requires computed length and exact computed bytes', () => {
  const expected={return:2,hex:'aabb'};
  assert(oracleMatches({returnValue:2,outputs:{destination:'aabb0000'}},expected));
  assert(!oracleMatches({returnValue:2,outputs:{destination:'aabc0000'}},expected));
  assert(!oracleMatches({returnValue:1,outputs:{destination:'aabb0000'}},expected));
  assert(!oracleMatches({returnValue:0,outputs:{destination:''}},{return:0,hex:''}));
  assert(!oracleMatches({returnValue:2,outputs:{destination:'aabb'}},undefined));
});
test('edited inputs revoke an in-flight result publication ticket', async () => {
  const revision=new Revision(),ticket=revision.value;
  let publish;const result=new Promise(resolve=>{publish=resolve;});
  const observed=result.then(value=>revision.current(ticket)?value:null);
  revision.change();publish('old worker result');
  assert.equal(await observed,null);assert(revision.current(revision.value));
});
