/* SPDX-License-Identifier: GPL-2.0-only */
'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createModule}=require('./objects.cjs');
const MAX_JSON=64*1024*1024, MAX_OUTPUT=64*1024*1024;
function read(file){if(fs.statSync(file).size>MAX_JSON)throw Error('JSON exceeds 64 MiB');return JSON.parse(fs.readFileSync(file,'utf8'));}
function ownObject(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
async function main(argv,base=process.cwd(),output=value=>console.log(JSON.stringify(value))){
 const options={module:'module.json',program:'operations.json'};
 let position=false;
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];
  if(arg.startsWith('--')){
   const key={'--module':'module','--checkpoint':'checkpoint','--checkpoint-out':'checkpointOut'}[arg];
   if(!key)throw Error('Unknown option '+arg);
   if(!argv[i+1]||argv[i+1].startsWith('--'))throw Error('Missing filename for '+arg);
   if(Object.hasOwn(options,key)&&key!=='module')throw Error('Duplicate option '+arg);
   options[key]=argv[++i];
  }else{if(position)throw Error('Only one operations file is accepted');options.program=arg;position=true;}
 }
 const file=name=>path.resolve(base,name);
 const destination=options.checkpointOut?file(options.checkpointOut):null;
 if(destination&&fs.existsSync(destination))throw Error('Checkpoint output already exists');
 const module=read(file(options.module)),program=read(file(options.program));
 if(!ownObject(program)||program.schema!=='capsulith.operations.v1'||!Array.isArray(program.operations)||program.operations.length>256||Object.keys(program).some(k=>!['schema','operations','limits'].includes(k)))throw Error('A bounded capsulith.operations.v1 program is required');
 const controller=new AbortController();let instance;
 const timer=setTimeout(()=>{controller.abort();instance?.close();},60000);
 try{
  instance=await createModule(module,{...(program.limits===undefined?{}:{limits:program.limits}),...(options.checkpoint?{checkpoint:read(file(options.checkpoint))}:{}),signal:controller.signal});
  const aliases=new Map(),operations=[];
  const resultDocument={schema:'capsulith.operations.result.v1',moduleId:module.id,instanceId:instance.instanceId,operations};
  let outputBytes=Buffer.byteLength(JSON.stringify(resultDocument));
  const outputLimit=()=>{const error=new Error('Result exceeds 64 MiB');error.code='OUTPUT_LIMIT';return error;};
  const argument=value=>{
   if(ownObject(value)&&Object.hasOwn(value,'use')){
    if(Object.keys(value).length!==1||typeof value.use!=='string'||!aliases.has(value.use))throw Error('Unknown result reference');
    return aliases.get(value.use);
   }
   return value;
  };
  for(const op of program.operations){
   if(controller.signal.aborted)throw Error('Program stopped at the 60-second limit');
   if(!ownObject(op)||typeof op.op!=='string')throw Error('Each operation must declare its op');
   if(op.as!==undefined&&(typeof op.as!=='string'||!op.as||op.as.length>80||aliases.has(op.as)))throw Error('Result names must be unique and at most 80 characters');
   const allowed={allocate:['op','as','spec'],call:['op','as','method','args','options'],reference:['op','as','regionId','offset'],read:['op','as','reference','length'],release:['op','reference']}[op.op];
   if(!allowed||Object.keys(op).some(k=>!allowed.includes(k)))throw Error('Unknown operation or field');
   let result,value;
   if(op.op==='allocate'){result=await instance.allocateBuffer(op.spec);value=result;}
   else if(op.op==='reference'){result=instance.reference(op.regionId,op.offset??0);value=result;}
   else if(op.op==='call'){
    if(!Array.isArray(op.args))throw Error('Call args must be an array');
    if(op.options!==undefined&&(!ownObject(op.options)||Object.keys(op.options).some(k=>!['traceLimit','instructionLimit','timeoutMs'].includes(k))))throw Error('Only call work limits are accepted');
    result=await instance.call(op.method,op.args.map(argument),{traceLimit:0,...op.options,signal:controller.signal});value=result.returnValue;
   }else if(op.op==='read'){result=await instance.readBuffer(argument(op.reference),op.length);value=result;}
   else result=await instance.releaseBuffer(argument(op.reference));
   const record={op:op.op,...(op.method?{method:op.method}:{}),...(op.as?{as:op.as}:{}),result:result??null};
   const recordBytes=Buffer.byteLength(JSON.stringify(record))+(operations.length?1:0);
   if(outputBytes+recordBytes>MAX_OUTPUT)throw outputLimit();
   outputBytes+=recordBytes;
   if(op.as!==undefined)aliases.set(op.as,value);
   operations.push(record);
  }
  if(controller.signal.aborted)throw Error('Program stopped at the 60-second limit');
  const result=resultDocument;
  if(Buffer.byteLength(JSON.stringify(result))>MAX_OUTPUT)throw outputLimit();
  if(destination){
   const checkpoint=await instance.checkpoint();
   if(controller.signal.aborted)throw Error('Program stopped at the 60-second limit');
   const encoded=JSON.stringify(checkpoint,null,2)+'\n';
   if(Buffer.byteLength(encoded)>MAX_JSON)throw Error('Checkpoint exceeds 64 MiB');
   fs.writeFileSync(destination,encoded,{flag:'wx',mode:0o600});
  }
  output(result);return result;
 }finally{clearTimeout(timer);if(instance)await instance.close();}
}
module.exports={main};
if(require.main===module)main(process.argv.slice(2)).catch(e=>{console.error(JSON.stringify({code:e.code||'INPUT',message:e.message}));process.exitCode=1;});
