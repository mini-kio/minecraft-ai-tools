import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const root=path.resolve('.'),qa=path.join(root,'work/blockbench-qa'),hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
for(const version of ['4.12.6','5.2.2']){
 const reports=[];for(const dir of await fs.readdir(qa)){if(!dir.startsWith('run-'))continue;try{const file=path.join(qa,dir,'evidence.json'),bytes=await fs.readFile(file),report=JSON.parse(bytes);if(report.version===version&&report.status==='passed'&&report.checks.externalTextureReloadChangesPixels&&report.nativeFilesystem.startsWith('real CLI filesystem'))reports.push({file,bytes,report});}catch{}}
 reports.sort((a,b)=>a.report.finishedAt.localeCompare(b.report.finishedAt));const current=reports.at(-1);if(!current)throw new Error(`No current production file-transport evidence for ${version}`);
 const destination=path.join(root,'bridges/blockbench/evidence',version);await fs.mkdir(destination,{recursive:true});const files=[];
 async function copy(file,name,kind){const bytes=await fs.readFile(file);await fs.writeFile(path.join(destination,name),bytes);files.push({file:name,kind,bytes:bytes.length,sha256:hash(bytes)});}
 await copy(current.file,'evidence.json','unchanged-runtime-report');for(const field of ['initial','half','camera','externalTexture'])await copy(current.report[field].imagePath,field+'.png','actual-renderer-capture');
 // Preserve the independent official-app startup diagnosis alongside new MCT evidence.
 if(version==='5.2.2')for(const name of ['vanilla-startup-baseline.json','console-diagnosis.json']){const bytes=await fs.readFile(path.join(destination,name));files.push({file:name,kind:'official-app-control-diagnosis',bytes:bytes.length,sha256:hash(bytes)});}
 const metadata={schemaVersion:2,version,status:'passed',sourceRun:path.basename(path.dirname(current.file)),startedAt:current.report.startedAt,finishedAt:current.report.finishedAt,checks:current.report.checks,fileTransport:current.report.nativeFilesystem,scope:'Actual official desktop plugin file loader, actual CLI model and external texture files, production WebSocket/model services, original codec and renderer; no filesystem adapter or app permission modifications.',consoleEntries:current.report.consoleEvents?.length||0,files};await fs.writeFile(path.join(destination,'metadata.json'),JSON.stringify(metadata,null,2)+'\n');
 console.log(JSON.stringify({version,checks:Object.keys(metadata.checks).length,files:files.length,sourceRun:metadata.sourceRun}));
}
