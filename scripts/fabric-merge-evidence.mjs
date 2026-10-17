#!/usr/bin/env node
/** Merge only successful real-client reports whose installed JAR hash matches the current artifact. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'bridges/fabric/compatibility.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const roots = process.argv.slice(2).length ? process.argv.slice(2).map(p => path.resolve(p)) : ['work/fabric-runtime-legacy', 'work/fabric-runtime-modern'].map(p=>path.join(root,p));
const files=[];
async function walk(dir){for(const e of await fs.readdir(dir,{withFileTypes:true}).catch(()=>[])){const p=path.join(dir,e.name);if(e.isDirectory())await walk(p);else if(e.name==='result.json')files.push(p);}}
for(const dir of roots)await walk(dir);
const reports=[];for(const filename of files){try{reports.push({filename,report:JSON.parse(await fs.readFile(filename,'utf8'))});}catch{}}
const mandatory=['connect','observe','move','command','interact','capture','cancel'];
let verified=0;
for(const version of manifest.versions){
  const actual=crypto.createHash('sha256').update(await fs.readFile(path.join(root,version.artifact))).digest('hex');
  if(actual!==version.sha256)throw new Error('Artifact hash changed after build: '+version.version);
  const candidate=reports.filter(({report:r})=>r.version===version.version&&r.runtimeVerified&&r.artifactSha256===actual&&(r.hotbar?.pass||['pass','passed'].includes((r.scenarios??{})['hotbar']))&&(r.guiClicks?.pass||(['pass','passed'].includes(r.scenarios?.interact)&&r.guiClickEvidence?.restoredCount===3))&&(r.unicodeChat?.pass||['pass','passed'].includes(r.scenarios?.['gui-unicode']))&&mandatory.every(s=>['pass','passed'].includes((r.runtimeScenarios??r.scenarios??{})[s]))).sort((a,b)=>String(b.report.finishedAt).localeCompare(String(a.report.finishedAt)))[0];
  if(!candidate){version.runtimeVerified=false;continue;}
  const {report,filename}=candidate;verified++;
  version.runtimeVerified=true;version.runtimeScenarios=Object.fromEntries([...mandatory,'hotbar','guiLeftClick','guiRightClick','guiUnicodeChat'].map(k=>[k,'passed']));
  const evidenceDir=path.join(root,'bridges/fabric/evidence',version.version);await fs.mkdir(evidenceDir,{recursive:true});
  const raw=await fs.readFile(filename);const portable=path.join(evidenceDir,'result.json');await fs.writeFile(portable,raw);
  const images=[];
  for(const name of ['native-hud.png','native-chest.png','native-unicode-chat.png','native-inventory.png','world-screen.png','chest-screen.png']){
    try{const bytes=await fs.readFile(path.join(path.dirname(filename),name));if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error('Invalid PNG evidence');await fs.writeFile(path.join(evidenceDir,name),bytes);images.push({file:path.relative(root,path.join(evidenceDir,name)).replaceAll('\\','/'),sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  version.runtimeEvidence={file:path.relative(root,portable).replaceAll('\\','/'),originalReport:path.relative(root,filename).replaceAll('\\','/'),reportSha256:crypto.createHash('sha256').update(raw).digest('hex'),images,artifactSha256:actual,sourceSha256:version.sourceSha256??manifest.sourceSha256,startedAt:report.startedAt,finishedAt:report.finishedAt,additionalScenarios:report.additionalScenarios??report.scenarios??null};
}
manifest.runtimeEvidenceMergedAt=new Date().toISOString();manifest.runtimeVerifiedCount=verified;
await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2)+'\n');
const lines=['# Native Fabric verification','','Each accepted runtime report matches the current shipped JAR SHA-256. Core checks cover connect, observe, move, command, chest interaction, native capture and cancellation. Hotbar selection, actual left/right GUI stack changes and Unicode chat are additional required checks.','','| Minecraft | Java | Core + hotbar + GUI + Unicode | Native registry states | Evidence |','| --- | --- | --- | ---: | --- |'];
for(const row of manifest.versions){let registry='pending';try{const metadata=JSON.parse(await fs.readFile(path.join(root,'bridges/fabric/collision-data',row.version+'.json.gz.metadata.json'),'utf8'));if(metadata.artifactSha256===row.sha256)registry=`${metadata.staticStates} / ${metadata.states} static`;}catch{}lines.push(`| ${row.version} | ${row.java} | ${row.runtimeVerified?'passed':'pending'} | ${registry} | ${row.runtimeVerified?`[report](./${row.version}/result.json)`:'pending'} |`);}
lines.push('','Registry rows without a certified static shape remain context dependent. Bundled context cases require their recorded exact position, dimension, literal state and dependencies; entity-sensitive cases remain unknown. The [collision index](../collision-data/index.json) records dataset checksums and source/artifact hashes.','','Detailed logs remain in ignored work directories. Portable raw reports and native PNGs are included beside this file.');
await fs.mkdir(path.join(root,'bridges/fabric/evidence'),{recursive:true});await fs.writeFile(path.join(root,'bridges/fabric/evidence/README.md'),lines.join('\n')+'\n');
console.log(JSON.stringify({verified,total:manifest.versions.length,remaining:manifest.versions.filter(v=>!v.runtimeVerified).map(v=>v.version),sourceSha256:manifest.sourceSha256}));
