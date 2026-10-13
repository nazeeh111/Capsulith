/* SPDX-License-Identifier: GPL-2.0-only */
// Local explicit-file CLI. No server, eval or host execution of the artifact.
const fs=require('node:fs'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {createModule}=require('../../runtime/objects.cjs');
const base=__dirname;
function read(file,max){if(fs.statSync(file).size>max)throw Error('Input exceeds file bound');return fs.readFileSync(file);}
async function main(){
  const {makeImageCodec}=await import(pathToFileURL(path.join(base,'../../studio/image-codec-core.mjs')));
  const codec=makeImageCodec(createModule,JSON.parse(fs.readFileSync(path.join(base,'module.json'))));
  const args=process.argv.slice(2),op=args.shift(),count=op==='encode'?3:1;
  if(!['encode','decode','restore'].includes(op)||args.length<count)throw Error('Use encode WIDTH HEIGHT pixels.rgba --out NEW.qoi; decode input.qoi --out NEW.rgba [--preserve NEW.image.json]; restore image.json --out NEW.rgba');
  const values=args.splice(0,count),options={};
  while(args.length){const flag=args.shift(),value=args.shift();if(!['--out','--preserve'].includes(flag)||!value||options[flag])throw Error('Unknown, missing or repeated option');options[flag]=value;}
  if(!options['--out']||(options['--preserve']&&op!=='decode'))throw Error('An output is required; only decode accepts --preserve');
  const outputs=Object.values(options).map(p=>path.resolve(p));
  if(new Set(outputs).size!==outputs.length||outputs.some(p=>fs.existsSync(p)))throw Error('Output paths must be distinct and new');
  let result,data;
  if(op==='encode'){
    const width=Number(values[0]),height=Number(values[1]);
    result=await codec.encodePixels({width,height,rgba:Uint8Array.from(read(values[2],1048576))});data=result.qoi;
  }else if(op==='decode'){
    result=await codec.decodeQoi(Uint8Array.from(read(values[0],1048576)),{preserve:!!options['--preserve']});data=result.rgba;
  }else{result=await codec.restorePixels(JSON.parse(read(values[0],8*1048576)));data=result.rgba;}
  fs.writeFileSync(options['--out'],data,{flag:'wx'});
  if(options['--preserve'])fs.writeFileSync(options['--preserve'],JSON.stringify(result.preserved),{flag:'wx'});
  console.log(JSON.stringify({operation:op,width:result.width,height:result.height,bytes:data.length,instanceId:result.instanceId,freed:result.freed,stats:result.stats}));
}
main().catch(e=>{console.error(JSON.stringify({code:e.code||'IMAGE',message:e.message}));process.exitCode=1;});
