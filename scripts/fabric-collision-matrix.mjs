#!/usr/bin/env node
/** Generate bundled collision tables from every exact native client, without touching user worlds. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),run=promisify(execFile);
const argv=process.argv.slice(2),opt=(key,fallback)=>{const i=argv.indexOf(key);return i<0?fallback:argv[i+1];};
const javaHome=path.resolve(opt('--java-home',process.env.JAVA_HOME??'')),java=path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java');
const output=path.resolve(opt('--output',path.join(root,'work/fabric-runtime-registry/tables'))),tables=path.resolve(opt('--tables',path.join(root,'bridges/fabric/collision-data')));
const compatibility=JSON.parse(await fs.readFile(path.join(root,'bridges/fabric/compatibility.json'),'utf8'));
const requested=opt('--versions')?.split(','),versions=compatibility.versions.filter(row=>!requested||requested.includes(row.version));
const summary={startedAt:new Date().toISOString(),versions:[]},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
await fs.mkdir(output,{recursive:true});
for(const artifact of versions){
  const version=artifact.version,dir=path.join(output,version),gameDir=path.join(root,'work/fabric-registry-runtime',version),row={version,artifactSha256:artifact.sha256};summary.versions.push(row);let client;
  try{
    if(argv.includes('--resume')){try{const existing=JSON.parse(await fs.readFile(path.join(tables,version+'.json.gz.metadata.json'),'utf8')),bytes=await fs.readFile(path.join(tables,version+'.json.gz'));if(existing.artifactSha256===artifact.sha256&&crypto.createHash('sha256').update(bytes).digest('hex')===existing.sha256){row.export=existing;row.reused=true;row.passed=true;console.log(version+': exact-artifact dataset already verified');continue;}}catch{}}
    await fs.mkdir(dir,{recursive:true});console.log(version+': preparing exact client');
    const prepared=await run(process.execPath,[path.join(root,'scripts/fabric-smoke.mjs'),'--java-home',javaHome,'--version',version,'--game-dir',gameDir,'--prepare-only'],{cwd:root,windowsHide:true,timeout:240000,maxBuffer:8*1024*1024});await fs.writeFile(path.join(dir,'prepare.log'),prepared.stdout+prepared.stderr);
    const launch=JSON.parse(await fs.readFile(path.join(gameDir,'launch.json'),'utf8')),log=await fs.open(path.join(dir,'client-console.log'),'w');client=spawn(java,launch.args,{cwd:gameDir,windowsHide:true,stdio:['ignore',log.fd,log.fd]});await log.close();row.clientPid=client.pid;
    const discoveryPath=path.join(gameDir,'.mct',`fabric-${client.pid}.json`);let discovery,state;const deadline=Date.now()+120000;
    while(Date.now()<deadline){if(client.exitCode!==null)throw new Error('Client exited before registry export: '+client.exitCode);try{discovery=JSON.parse(await fs.readFile(discoveryPath,'utf8'));const response=await fetch('http://127.0.0.1:'+discovery.port+'/status',{headers:{Authorization:'Bearer '+discovery.token},signal:AbortSignal.timeout(3000)});state=await response.json();if(state.ready&&!state.loading)break;}catch{}await sleep(250);}
    if(!state?.ready||state.loading)throw new Error('Client resource loading timed out');
    const headers={Authorization:'Bearer '+discovery.token,'Content-Type':'application/json'};const response=await fetch('http://127.0.0.1:'+discovery.port+'/call',{method:'POST',headers,body:JSON.stringify({action:'capture',args:{}}),signal:AbortSignal.timeout(16000)});const image=await response.json();if(!response.ok||!image.base64)throw new Error('Native title framebuffer unavailable: '+JSON.stringify(image));const png=Buffer.from(image.base64,'base64');await fs.writeFile(path.join(dir,'native-title.png'),png);row.captureSha256=crypto.createHash('sha256').update(png).digest('hex');
    const exported=await run(process.execPath,[path.join(root,'scripts/fabric-collision-export.mjs'),'--discovery',discoveryPath,'--output',tables],{cwd:root,windowsHide:true,timeout:240000,maxBuffer:8*1024*1024});await fs.writeFile(path.join(dir,'export.log'),exported.stdout+exported.stderr);row.export=JSON.parse(exported.stdout.trim().split(/\r?\n/).at(-1));row.passed=true;console.log(version+': '+row.export.staticStates+'/'+row.export.states+' exact static states verified');
  }catch(error){row.error=String(error.stack??error);process.exitCode=1;console.error(version+': '+row.error);}
  finally{if(client&&client.exitCode===null){client.kill();await Promise.race([new Promise(resolve=>client.once('exit',resolve)),sleep(10000)]);}row.finishedAt=new Date().toISOString();await fs.writeFile(path.join(output,'matrix.json'),JSON.stringify(summary,null,2));}
}
summary.finishedAt=new Date().toISOString();await fs.writeFile(path.join(output,'matrix.json'),JSON.stringify(summary,null,2));
