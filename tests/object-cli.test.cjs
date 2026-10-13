/* SPDX-License-Identifier: GPL-2.0-only */
'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path');
const {main}=require('../runtime/object-cli.cjs');
const fixture=path.join(__dirname,'fixtures/native-objects');
const moduleDocument=JSON.parse(fs.readFileSync(path.join(fixture,'module.json')));
test('portable operations run original factory, save state and resume with rebinding',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capsulith-ops-'));
 fs.writeFileSync(path.join(dir,'module.json'),JSON.stringify(moduleDocument));
 fs.writeFileSync(path.join(dir,'start.json'),JSON.stringify({schema:'capsulith.operations.v1',operations:[{op:'call',method:'create',args:[],as:'stream'}]}));
 let result; await main(['start.json','--checkpoint-out','saved.json'],dir,x=>result=x);
 assert.equal(result.operations[0].result.returnValue.regionId,'region1');
 const cp=JSON.parse(fs.readFileSync(path.join(dir,'saved.json')));assert.equal(cp.calls,1);
 fs.writeFileSync(path.join(dir,'end.json'),JSON.stringify({schema:'capsulith.operations.v1',operations:[{op:'reference',regionId:'region1',as:'stream'},{op:'call',method:'free',args:[{use:'stream'}]}]}));
 await main(['end.json','--checkpoint','saved.json','--checkpoint-out','ended.json'],dir,x=>result=x);
 assert.equal(result.operations[1].result.returnValue,0);assert.notEqual(result.instanceId,cp.originInstanceId);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'ended.json'))).regions.length,0);
 await assert.rejects(main(['start.json','--checkpoint-out','saved.json'],dir,()=>{}),/exists/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'saved.json'))).calls,1);
});
test('bad operation/refuse unknown variable never saves a successful checkpoint',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capsulith-ops-'));
 fs.writeFileSync(path.join(dir,'module.json'),JSON.stringify(moduleDocument));
 fs.writeFileSync(path.join(dir,'bad.json'),JSON.stringify({schema:'capsulith.operations.v1',operations:[{op:'call',method:'free',args:[{use:'missing'}]}]}));
 await assert.rejects(main(['bad.json','--checkpoint-out','out.json'],dir,()=>{}),/Unknown result/);assert.equal(fs.existsSync(path.join(dir,'out.json')),false);
 fs.writeFileSync(path.join(dir,'empty.json'),JSON.stringify({schema:'capsulith.operations.v1',operations:[]}));
 await assert.rejects(main(['empty.json','--unknown'],dir,()=>{}),/Unknown option/);
});
test('result budget stops accumulated reads before later operations or checkpoint output',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capsulith-result-bound-'));
 fs.writeFileSync(path.join(dir,'module.json'),JSON.stringify(moduleDocument));
 const operations=[{op:'allocate',as:'data',spec:{name:'large',bytes:'',access:'readwrite',capacity:8*1024*1024}},...Array.from({length:5},()=>({op:'read',reference:{use:'data'},length:8*1024*1024})),{op:'must_not_be_reached'}];
 fs.writeFileSync(path.join(dir,'large.json'),JSON.stringify({schema:'capsulith.operations.v1',operations}));
 let published=false;
 await assert.rejects(main(['large.json','--checkpoint-out','not-saved.json'],dir,()=>{published=true;}),error=>error.code==='OUTPUT_LIMIT');
 assert.equal(published,false);assert.equal(fs.existsSync(path.join(dir,'not-saved.json')),false);
});
