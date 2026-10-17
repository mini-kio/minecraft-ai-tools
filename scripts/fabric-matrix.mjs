#!/usr/bin/env node
/** Modern exact-version native acceptance matrix with isolated local Vanilla servers. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (key, fallback) => { const i = argv.indexOf(key); return i < 0 ? fallback : argv[i + 1]; };
const javaHomeOption = option('--java-home', process.env.JAVA_HOME); if (!javaHomeOption) throw new Error('--java-home required'); const javaHome=path.resolve(javaHomeOption);
if (!argv.includes('--accept-eula')) throw new Error('Pass --accept-eula for isolated Vanilla servers');
const java = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const versions = option('--versions', '26.1,26.1.1,26.1.2,26.2,26.3').split(',');
const output = path.resolve(option('--output', path.join(root, 'work/fabric-runtime-modern/final'))); await fs.mkdir(output, { recursive: true });
const { ServerService } = await import('../dist/servers/index.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const summary = { startedAt: new Date().toISOString(), versions: [] };
const log = (event, data) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
async function waitFor(fn, label, timeout = 90000) { const start = Date.now(); let last; while (Date.now()-start < timeout) { try { const value = await fn(); if (value) return value; } catch (error) { last=error; } await sleep(250); } throw new Error(label + ': ' + (last?.message ?? 'timeout')); }
for (const version of versions) {
  const dir = path.join(output, version); await fs.mkdir(dir, { recursive: true });
  let client, service, id; const row = {version,startedAt:new Date().toISOString()}; summary.versions.push(row);
  try {
    log('prepare', {version});
    const gameDir=option('--client-root')?path.resolve(option('--client-root'),version):path.join(root,'work/fabric-tools','smoke-'+version);
    const prepared = await run(process.execPath, [path.join(root, 'scripts/fabric-smoke.mjs'), '--java-home', javaHome, '--version', version, '--game-dir',gameDir,'--prepare-only'], { cwd: root, windowsHide: true, timeout: 240000, maxBuffer: 4*1024*1024 });
    await fs.writeFile(path.join(dir, 'prepare.log'), prepared.stdout+prepared.stderr);
    service = new ServerService({ stateDir:path.join(dir,'state'),artifactDir:dir });
    const created = await service.call('create', {version,acceptEula:true}); id=created.sessionId;
    await fs.appendFile(path.join(created.directory,'server.properties'), '\nwhite-list=false\nlevel-type=minecraft:flat\ngenerate-structures=false\ndifficulty=peaceful\n');
    row.server = {sessionId:id,version,port:created.port,directory:created.directory};
    await service.call('start', {session:id,javaPath:java,memoryMb:1024});
    await waitFor(async()=>{const state=await service.call('observe',{session:id});if(state.state==='failed')throw new Error(state.lastError);return state.state==='running';},'server ready',120000);
    const launch=JSON.parse(await fs.readFile(path.join(gameDir,'launch.json'),'utf8'));
    const logfile=await fs.open(path.join(dir,'client-console.log'),'w'); client=spawn(java,launch.args,{cwd:gameDir,windowsHide:true,stdio:['ignore',logfile.fd,logfile.fd]}); client.on('exit',(code,signal)=>log('client-exit',{version,code,signal})); await logfile.close();row.clientPid=client.pid;
    const discoveryPath=path.join(gameDir,'.mct',`fabric-${client.pid}.json`);row.discovery=discoveryPath;
    const discovery=await waitFor(async()=>JSON.parse(await fs.readFile(discoveryPath,'utf8')),'bridge discovery');
    const base='http://127.0.0.1:'+discovery.port;const headers={Authorization:'Bearer '+discovery.token,'Content-Type':'application/json'};
    async function call(action,args={}){const response=await fetch(base+'/call',{method:'POST',headers,body:JSON.stringify({action,args}),signal:AbortSignal.timeout(16000)});const value=await response.json();if(!response.ok||value.error)throw new Error(JSON.stringify(value));return value;}
    await waitFor(async()=>{const state=await call('observe');return state.ready&&!state.loading;},'client ready');await sleep(1000);
    await call('connect',{host:'127.0.0.1',port:created.port});await waitFor(async()=>{const s=await call('observe');return s.connected&&!s.loading&&!s.screen;},'join and terrain screen dismissed');
    for(const command of ['op MctSmoke','gamemode creative MctSmoke','fill 160 90 316 180 90 336 stone','fill 160 91 316 180 97 336 air','setblock 172 91 326 chest[facing=west]','tp MctSmoke 169.5 91 326.5','time set noon','weather clear']) await service.call('command',{session:id,command});
    await sleep(1200);log('acceptance',{version,port:created.port,pid:client.pid});
    if(argv.includes('--skip-verify')) { row.runtimeVerified=false; row.verification='explicitly-skipped-QA-setup-only'; }
    else {
      try { const verification=await run(process.execPath,[path.join(root,'scripts/fabric-verify.mjs'),'--discovery',discoveryPath,'--port',String(created.port),'--output',dir],{cwd:root,windowsHide:true,timeout:180000,maxBuffer:4*1024*1024});console.log(verification.stdout); await fs.writeFile(path.join(dir,'verify.log'),verification.stdout+verification.stderr); }
      catch(error){await fs.writeFile(path.join(dir,'verify.log'),String(error.stdout??'')+String(error.stderr??''));throw error;}
      const result=JSON.parse(await fs.readFile(path.join(dir,'result.json'),'utf8'));row.runtimeVerified=result.runtimeVerified;row.artifactSha256=result.artifactSha256;row.scenarios=result.scenarios;row.evidence=path.join(dir,'result.json');
    }
    if(argv.includes('--leave-running')&&version===versions.at(-1)){
      if(!(await call('observe')).connected) await call('connect',{host:'127.0.0.1',port:created.port});await waitFor(async()=>(await call('observe')).connected,'rejoin for interactive QA');
      row.leftRunning=true;row.finishedAt=new Date().toISOString();summary.finishedAt=new Date().toISOString();await fs.writeFile(path.join(output,'matrix.json'),JSON.stringify(summary,null,2));log('left-running',row);
      // Keep the owning local server/client processes alive for root CLI acceptance.
      await new Promise(resolve=>{process.on('SIGINT',resolve);process.on('SIGTERM',resolve);});
    }
  }catch(error){row.error=String(error.stack??error);process.exitCode=1;log('failure',{version,error:row.error});}
  finally{
    if(client&&client.exitCode===null){client.kill();await Promise.race([new Promise(resolve=>client.once('exit',resolve)),sleep(10000)]);}
    if(service)await service.close().catch(()=>{});
    row.finishedAt=new Date().toISOString();await fs.writeFile(path.join(output,'matrix.json'),JSON.stringify(summary,null,2));log('finished',row);
  }
}
summary.finishedAt=new Date().toISOString();await fs.writeFile(path.join(output,'matrix.json'),JSON.stringify(summary,null,2));
