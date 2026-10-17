import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {gzipSync} from 'node:zlib';
import {Application} from '../dist/app.js';
const require=createRequire(import.meta.url),nbt=require('prismarine-nbt'),argv=process.argv.slice(2),option=(key,fallback)=>{const i=argv.indexOf(key);return i<0?fallback:argv[i+1];};
if(!argv.includes('--accept-eula'))throw new Error('--accept-eula required');
const output=path.resolve(option('--output','work/file-stage-client')),app=new Application({stateDir:output,artifactDir:path.join(output,'captures')});await fs.mkdir(output,{recursive:true});
const evidence={startedAt:new Date().toISOString(),checks:{},formats:[]},hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
let client;
try{
 client=await app.execute('client','attach',{path:option('--discovery')});assert.equal((await app.execute('client','observe',{session:client.id})).connected,false);
 const tag=(type,value)=>({type,value}),list=(type,value)=>tag('list',{type,value});
 const structure=path.join(output,'fixture.nbt');
 await fs.writeFile(structure,gzipSync(nbt.writeUncompressed({type:'compound',name:'',value:{DataVersion:tag('int',5023),size:list('int',[3,2,1]),palette:list('compound',[{Name:tag('string','minecraft:stone')},{Name:tag('string','minecraft:air')},{Name:tag('string','minecraft:chest'),Properties:tag('compound',{facing:tag('string','west'),type:tag('string','single'),waterlogged:tag('string','false')})}]),blocks:list('compound',[...Array.from({length:3},(_,x)=>({pos:list('int',[x,0,0]),state:tag('int',0)})),...Array.from({length:3},(_,x)=>({pos:list('int',[x,1,0]),state:tag('int',x===1?2:1)}))])}})));
 const source=JSON.parse(await fs.readFile('work/file-stage-proof/evidence.json','utf8')).versions.find(v=>v.version==='26.3');
 const world=path.join(source.server.directory,'world'),regions=path.join(world,'dimensions/minecraft/overworld/region');
 const candidates=await fs.readdir(regions),region=path.join(regions,candidates.find(n=>n==='r.-1.-1.mca'));
 const fixtures=[{format:'schem',file:path.resolve('work/file-stage-proof/26.3/fixture.schem'),min:{x:-18,y:64,z:-2},max:{x:-16,y:65,z:-2},chest:{x:-17,y:65,z:-2}},{format:'nbt',file:structure,min:{x:0,y:0,z:0},max:{x:2,y:1,z:0},chest:{x:1,y:1,z:0}},{format:'mca',file:region,min:{x:-18,y:64,z:-2},max:{x:-16,y:65,z:-2},chest:{x:-17,y:65,z:-2}}];
 for(const fixture of fixtures){
  const before=hash(await fs.readFile(fixture.file)),map=await app.execute('map','open',{path:fixture.file,version:'26.3'});
  try{
   const staged=await app.execute('map','stage',{session:map.session,client:client.id,acceptEula:true,bounds:{min:fixture.min,max:fixture.max},memoryMb:1024});
   await app.execute('map','camera',{session:map.session,position:{x:fixture.chest.x+3,y:fixture.chest.y+4,z:fixture.chest.z+5},target:fixture.chest});
   let blocks;for(let i=0;i<100;i++){blocks=await app.execute('client','blocks',{session:client.id,min:fixture.min,max:fixture.max});if(blocks.blocks.every(b=>b.known))break;await new Promise(r=>setTimeout(r,100));}
   const chest=blocks.blocks.find(b=>b.position.x===fixture.chest.x&&b.position.y===fixture.chest.y&&b.position.z===fixture.chest.z);assert.equal(chest.name,'minecraft:chest');assert.equal(chest.properties.facing,'west');
   const selected=await app.execute('player','inventory',{session:client.id,operation:'select',slot:5});assert.equal(selected.player.selectedSlot,5);await app.execute('player','inventory',{session:client.id,operation:'select',slot:0});
   const capture=await app.execute('map','capture',{session:map.session});assert.equal(capture.source,'minecraft-client');
   assert.equal(hash(await fs.readFile(fixture.file)),before);evidence.formats.push({format:fixture.format,sourceSha256:before,originalUnchanged:true,staging:staged.imported,block:chest,capture:capture.imagePath,hotbar:true});
   console.log(JSON.stringify({format:fixture.format,passed:true,imagePath:capture.imagePath}));
  }finally{await app.execute('map','close',{session:map.session});}
 }
 evidence.checks.allPortableFormatsActualGame=true;evidence.checks.nativeHotbarThroughCommonInventoryCommand=true;evidence.passed=true;
}catch(error){evidence.passed=false;evidence.error=String(error.stack||error);console.error(evidence.error);process.exitCode=1;}
finally{await app.close();evidence.finishedAt=new Date().toISOString();await fs.writeFile(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));}
