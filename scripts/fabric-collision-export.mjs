#!/usr/bin/env node
/** Export and verify actual game's registry data from an authenticated companion. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),opt=(name,fallback)=>{const i=args.indexOf(name);return i<0?fallback:args[i+1];};
const discovery=JSON.parse(await fs.readFile(opt('--discovery'),'utf8'));
const headers={Authorization:'Bearer '+discovery.token,'Content-Type':'application/json'},base='http://127.0.0.1:'+discovery.port;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function call(action,args={}){const response=await fetch(base+'/call',{method:'POST',headers,body:JSON.stringify({action,args}),signal:AbortSignal.timeout(16000)});const value=await response.json();if(!response.ok||value.error)throw new Error(JSON.stringify(value));return value;}
const startArgs={operation:'start'};
if(args.includes('--fixture')) {
  for(const text of ['setblock 175 90 326 dirt','setblock 175 91 326 bamboo','setblock 175 91 327 powder_snow','setblock 176 91 326 oak_stairs[facing=east,half=bottom,shape=outer_left]','setblock 176 91 327 oak_door[facing=east,half=lower,hinge=left,open=true]'])await call('command',{text});
  await sleep(500);startArgs.contextBounds={min:{x:174,y:91,z:325},max:{x:177,y:92,z:328}};
}
const job=await call('collision-export',startArgs),deadline=Date.now()+180000;let state;
do{await sleep(500);state=await call('collision-export',{operation:'status',jobId:job.jobId});if(['failed','cancelled'].includes(state.state))throw new Error(JSON.stringify(state));if(Date.now()>deadline)throw new Error('Collision export timed out: '+JSON.stringify(state));}while(state.state!=='completed');
const result=await call('collision-export',{operation:'status',jobId:job.jobId,includeGzip:true});
const bytes=Buffer.from(result.gzipBase64,'base64');assert.equal(sha(bytes),result.sha256);
const data=JSON.parse(gunzipSync(bytes));assert.equal(data.gameVersion,discovery.gameVersion);assert.equal(data.schemaVersion,1);assert.equal(data.source,'fabric-exact-game-registry');assert.equal(data.shapeContext,'empty');
assert(data.states.length>20000);assert(data.defaultStates.length>900);assert.equal(data.states.length,result.processedStates);
const rows=name=>data.states.filter(row=>row.name==='minecraft:'+name),first=name=>rows(name)[0];
assert.deepEqual(first('stone').shapes,[[0,0,0,1,1,1]]);assert.deepEqual(first('air').shapes,[]);
assert(rows('oak_stairs').some(row=>row.shapes?.length>1));assert(rows('oak_door').every(row=>row.shapes?.length));
assert.equal(typeof data.defaultStates.find(row=>row.name==='minecraft:oak_stairs').properties.facing,'string');
const contextSummary={};
if(args.includes('--fixture')){
  assert(rows('bamboo').some(row=>row.shapes===null));const sample=data.contextCases.find(row=>row.state.name==='minecraft:bamboo');assert(sample,'Position-dependent bamboo must have an exact-position context case');assert.deepEqual(sample.position,{x:175,y:91,z:326});assert.equal(sample.dimension,'minecraft:overworld');
  const snapshot=await call('blocks',{min:{x:175,y:91,z:326},max:{x:175,y:91,z:326}});assert.deepEqual(sample.shapes,[...snapshot.blocks[0].shapes].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
  assert(data.unsupportedContextSamples.some(row=>row.state?.name==='minecraft:powder_snow'&&row.reason==='entity-context-sensitive'));
  Object.assign(contextSummary,{bambooExactPosition:sample.position,bambooShapes:sample.shapes,entitySensitiveUnknown:true});
}
const output=path.resolve(opt('--output',path.join(root,'bridges/fabric/collision-data')));await fs.mkdir(output,{recursive:true});const filename=path.join(output,discovery.gameVersion+'.json.gz');await fs.writeFile(filename,bytes);
const jar=await fs.readFile(path.join(path.dirname(opt('--discovery')),'..','mods','mct-bridge.jar'));
const metadata={schemaVersion:1,gameVersion:discovery.gameVersion,file:path.basename(filename),sha256:sha(bytes),artifactSha256:sha(jar),registryFingerprint:data.registryFingerprint,states:data.states.length,staticStates:data.states.filter(row=>row.shapes!==null).length,defaultStates:data.defaultStates.length,contextCases:data.contextCases.length,unsupportedContextSamples:data.unsupportedContextSamples.length,shapeContext:data.shapeContext,generatedAt:data.provenance.generatedAt,source:data.source,contextCasesExhaustive:false,contextProof:contextSummary};
const compatibility=JSON.parse(await fs.readFile(path.join(root,'bridges/fabric/compatibility.json'),'utf8'));const artifact=compatibility.versions.find(row=>row.version===discovery.gameVersion);if(artifact?.sha256===metadata.artifactSha256)metadata.sourceSha256=artifact.sourceSha256;
await fs.writeFile(filename+'.metadata.json',JSON.stringify(metadata,null,2));console.log(JSON.stringify(metadata));
