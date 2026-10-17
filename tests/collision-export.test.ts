import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {exportCollisionData} from '../src/collision-export.js';
import {nativeCollisionData} from '../src/maps/native-collisions.js';

const data={schemaVersion:1,gameVersion:'26.98',shapeContext:'empty',registryFingerprint:'fixture-exact-registry',states:[{name:'minecraft:stone',properties:{},shapes:[[0,0,0,1,0.75,1]]}],defaultStates:[{name:'minecraft:stone',properties:{}}],contextCases:[]};
function fixture(overrides:any={}){
  const bytes=gzipSync(JSON.stringify(data)),operations:string[]=[];
  const bridge={peers:new Map([['client',{id:'client',kind:'fabric',version:data.gameVersion}]]),request:async(_client:string,_action:string,args:any)=>{
    operations.push(args.operation+(args.includeGzip?':data':''));
    if(args.operation==='start')return{jobId:'fixture-export'};
    if(args.operation==='cancel')return{state:'cancelled'};
    return args.includeGzip?{state:'completed',gzipBase64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),...overrides}:{state:'completed'};
  }};
  return{bridge,operations,bytes};
}
test('invalid collision export timeouts and pre-aborted requests never start work in the game',async()=>{
  const f=fixture(),directory=await mkdtemp(path.join(tmpdir(),'mct-collision-export-'));
  for(const timeoutMs of [0,-1,NaN,Infinity,1.5,600001,'nonsense'])await assert.rejects(exportCollisionData(f.bridge as any,directory,{client:'client',timeoutMs}),{code:'INVALID_ARGUMENT'});
  const controller=new AbortController();controller.abort();
  await assert.rejects(exportCollisionData(f.bridge as any,directory,{client:'client',signal:controller.signal}),{code:'CANCELLED'});
  assert.deepEqual(f.operations,[]);assert.deepEqual(await readdir(directory),[]);
});
test('collision checksum failures preserve any previous installed dataset and cancel owned remote work',async()=>{
  const f=fixture({sha256:'0'.repeat(64)}),directory=await mkdtemp(path.join(tmpdir(),'mct-collision-export-')),file=path.join(directory,data.gameVersion+'.json.gz');
  await writeFile(file,'previous dataset');
  await assert.rejects(exportCollisionData(f.bridge as any,directory,{client:'client'}),{code:'COLLISION_INTEGRITY_FAILED'});
  assert.equal(await readFile(file,'utf8'),'previous dataset');assert.equal(f.operations.at(-1),'cancel');assert.deepEqual(await readdir(directory),[path.basename(file)]);
});
test('successful exact collision export is installed in the user state directory and immediately used',async()=>{
  const f=fixture(),directory=await mkdtemp(path.join(tmpdir(),'mct-collision-export-'));
  assert.equal(nativeCollisionData(data.gameVersion),undefined);
  const result=await exportCollisionData(f.bridge as any,directory,{client:'client'});
  assert.deepEqual(await readFile(result.path),f.bytes);
  const metadata=JSON.parse(await readFile(result.path+'.metadata.json','utf8'));assert.equal(metadata.sha256,result.sha256);
  const installed=nativeCollisionData(data.gameVersion)!;assert.equal(installed.fingerprint,data.registryFingerprint);assert.deepEqual(installed.states.get('minecraft:stone[]')!.shapes,[[0,0,0,1,0.75,1]]);
  assert.equal(result.contextCasesExhaustive,false);assert.equal(f.operations.includes('cancel'),false);assert.equal((await readdir(directory)).some(name=>name.endsWith('.tmp')),false);
});
test('cancellation while waiting for collision export awaits remote cleanup and reports CANCELLED',async()=>{
  const f=fixture(),controller=new AbortController(),request=f.bridge.request;let cancelled=false;
  f.bridge.request=async(client,action,args)=>{
    if(args.operation==='status'){setTimeout(()=>controller.abort(),5);return{state:'running'} as any;}
    const result=await request(client,action,args);if(args.operation==='cancel'){await new Promise(resolve=>setTimeout(resolve,15));cancelled=true;}return result;
  };
  const directory=await mkdtemp(path.join(tmpdir(),'mct-collision-export-'));
  await assert.rejects(exportCollisionData(f.bridge as any,directory,{client:'client',signal:controller.signal}),{code:'CANCELLED'});
  assert.equal(cancelled,true);assert.deepEqual(await readdir(directory),[]);
});
test('cancellation during final gzip delivery cannot install the result',async()=>{
  const f=fixture(),controller=new AbortController(),request=f.bridge.request;
  f.bridge.request=async(client,action,args)=>{const result=await request(client,action,args);if(args.includeGzip)controller.abort();return result;};
  const directory=await mkdtemp(path.join(tmpdir(),'mct-collision-export-'));
  await assert.rejects(exportCollisionData(f.bridge as any,directory,{client:'client',signal:controller.signal}),{code:'CANCELLED'});
  assert.deepEqual(await readdir(directory),[]);assert.equal(f.operations.at(-1),'cancel');
});
