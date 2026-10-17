import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile);
test('parallel CLI startup shares one authenticated daemon and malformed viewer paths do not crash it',async()=>{
  const stateDir=await fs.mkdtemp(path.resolve('work/daemon-'));
  const invoke=async(...args:string[])=>JSON.parse((await run(process.execPath,['bin/mct.mjs',...args,'--state-dir',stateDir,'--compact'],{windowsHide:true,timeout:30000})).stdout);
  try {
    const responses=await Promise.all([invoke('session','list'),invoke('session','list')]);assert.equal(responses.every(r=>r.ok),true);
    const inputFile=path.join(stateDir,'windows-input.json');await fs.writeFile(inputFile,'\uFEFF{"compact":true}');assert.equal((await invoke('session','list','--input',inputFile)).ok,true);
    const info=JSON.parse(await fs.readFile(path.join(stateDir,'daemon.json'),'utf8'));const url=`http://127.0.0.1:${info.port}`;
    assert.equal((await fetch(`${url}/health`)).status,401);
    const invalid=await fetch(`${url}/vendor/invalid.js`);assert.equal(invalid.status,400);
    const health=await fetch(`${url}/health`,{headers:{authorization:`Bearer ${info.token}`}});assert.equal(health.status,200);assert.equal((await health.json() as any).pid,info.pid);
    assert.equal((await fs.readdir(stateDir)).includes('startup.lock'),false);
    const origin=await fetch(`${url}/health`,{headers:{authorization:`Bearer ${info.token}`,origin:'https://unrelated.example'}});assert.equal(origin.status,403);
  } finally {await invoke('daemon','stop');}
});
