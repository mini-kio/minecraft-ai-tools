#!/usr/bin/env node
/** Integrity-check generated native collision data and publish its portable index. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),fabric=path.join(root,'bridges/fabric'),directory=path.join(fabric,'collision-data');
const compatibility=JSON.parse(await fs.readFile(path.join(fabric,'compatibility.json'),'utf8')),versions=[],missing=[],stale=[];
for(const artifact of compatibility.versions){
  const filename=path.join(directory,artifact.version+'.json.gz');let metadata,bytes;
  try{metadata=JSON.parse(await fs.readFile(filename+'.metadata.json','utf8'));bytes=await fs.readFile(filename);}catch(error){if(error.code==='ENOENT'){missing.push(artifact.version);continue;}throw error;}
  const sha=crypto.createHash('sha256').update(bytes).digest('hex');if(sha!==metadata.sha256)throw new Error(artifact.version+': collision table checksum mismatch');
  if(metadata.artifactSha256!==artifact.sha256){missing.push(artifact.version);stale.push({version:artifact.version,reason:'different-bridge-artifact',recorded:metadata.artifactSha256,expected:artifact.sha256});continue;}
  const data=JSON.parse(gunzipSync(bytes));if(data.gameVersion!==artifact.version||data.shapeContext!=='empty'||data.states.length!==metadata.states||data.registryFingerprint!==metadata.registryFingerprint)throw new Error(artifact.version+': collision table metadata mismatch');
  metadata.sourceSha256=artifact.sourceSha256;await fs.writeFile(filename+'.metadata.json',JSON.stringify(metadata,null,2));versions.push(metadata);
}
const index={schemaVersion:1,generatedAt:new Date().toISOString(),source:'fabric-exact-game-registry',shapeContext:'empty',contextCasesExhaustive:false,complete:missing.length===0,versions,missing,stale};await fs.mkdir(directory,{recursive:true});await fs.writeFile(path.join(directory,'index.json'),JSON.stringify(index,null,2));console.log(JSON.stringify({versions:versions.length,complete:index.complete,missing}));
