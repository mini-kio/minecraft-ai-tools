import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const run = promisify(execFile);
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const distance = (a, b) => Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z);
async function until(callback, timeout, label) { const end=Date.now()+timeout; let last; while(Date.now()<end) { try{const value=await callback();if(value)return value;}catch(error){if(error.fatal)throw error;last=error;} await sleep(200); } throw new Error('Timed out: '+label+(last?'; '+last.message:'')); }

/** Runs only against this test's own process, bridge token and loopback Paper server. */
export async function verifyNativePaper({root,directory,version,java,port,admin,result,onScenario}) {
  const gameDir=path.join(directory,'client'), javaHome=path.dirname(path.dirname(java)); let client; let current;
  const scenario=name=>{current=name;onScenario(name);};
  try {
    const prepared=await run(process.execPath,[path.join(root,'scripts/fabric-smoke.mjs'),'--java-home',javaHome,'--version',version,'--prepare-only','--game-dir',gameDir],{cwd:root,windowsHide:true,timeout:240000,maxBuffer:2*1024*1024});
    await fs.writeFile(path.join(directory,'client-prepare.log'),prepared.stdout+prepared.stderr);
    const launch=JSON.parse(await fs.readFile(path.join(gameDir,'launch.json'),'utf8'));
    const expected=JSON.parse(await fs.readFile(path.join(root,'bridges/fabric/compatibility.json'),'utf8')).versions.find(v=>v.version===version);
    result.artifactSha256=createHash('sha256').update(await fs.readFile(path.join(gameDir,'mods/mct-bridge.jar'))).digest('hex');
    assert(expected?.sha256===result.artifactSha256,'Prepared bridge differs from frozen compatibility artifact');
    const consoleFile=await fs.open(path.join(directory,'client-console.log'),'w');
    client=spawn(java,launch.args,{cwd:gameDir,windowsHide:true,stdio:['ignore',consoleFile.fd,consoleFile.fd]}); await consoleFile.close();
    let launchError;client.on('error',error=>{launchError=error;});result.clientPid=client.pid;
    const discovery=await until(async()=>{
      if(launchError||client.exitCode!==null)throw launchError||new Error('Minecraft client exited '+client.exitCode);
      for(const name of (await fs.readdir(path.join(gameDir,'.mct')).catch(()=>[])).filter(n=>n.endsWith('.json'))) {
        const record=JSON.parse(await fs.readFile(path.join(gameDir,'.mct',name),'utf8'));if(record.pid===client.pid)return record;
      }return false;
    },90000,'isolated Fabric discovery');
    const headers={authorization:`Bearer ${discovery.token}`,'content-type':'application/json'};
    async function api(action,args={}) {
      const response=await fetch(`http://127.0.0.1:${discovery.port}/call`,{method:'POST',headers,body:JSON.stringify({action,args}),signal:AbortSignal.timeout(20000)});
      const value=await response.json();if(!response.ok||value.error)throw new Error(`${action}: ${JSON.stringify(value.error||value)}`);return value;
    }
    async function status(){if(client.exitCode!==null)throw Object.assign(new Error('Owned Minecraft client exited '+client.exitCode),{fatal:true});const response=await fetch(`http://127.0.0.1:${discovery.port}/status`,{headers,signal:AbortSignal.timeout(12000)});assert(response.ok,'Bridge status HTTP '+response.status);return response.json();}
    async function capture(name){const value=await api('capture');assert(value.source==='fabric-game-framebuffer'&&value.base64,'Actual game framebuffer missing');const bytes=Buffer.from(value.base64,'base64');assert(bytes.subarray(1,4).toString()==='PNG','Invalid framebuffer PNG');const imagePath=path.join(directory,name+'.png');await fs.writeFile(imagePath,bytes);const{base64,...meta}=value;await fs.writeFile(imagePath+'.json',JSON.stringify(meta,null,2));return{...meta,imagePath,sha256:createHash('sha256').update(bytes).digest('hex')};}
    await until(async()=>{const s=await status();return s.ready&&s.frame>0&&s.loading===false;},120000,'resource loading completion');await sleep(1000);
    scenario('connect');await api('connect',{host:'127.0.0.1',port});await until(async()=>{const s=await status();return s.connected&&s.screen===null;},60000,'Paper connect');result.scenarios.connect='pass';
    scenario('observe');await admin('forceload add -8 -8 8 8');await sleep(500);
    for(const command of ['op MctSmoke','fill -8 99 -8 8 99 8 stone','fill -8 100 -8 8 105 8 air','gamemode creative MctSmoke','tp MctSmoke 0.5 100 0.5','time set noon','weather clear'])await admin(command);
    const initial=await until(async()=>{const s=await status();return s.player&&distance(s.player,{x:.5,y:100,z:.5})<.15?s:false;},15000,'arena');await sleep(500);
    const observed=await api('observe');assert(observed.connected&&observed.inventory?.slots?.length>=36,'Player and inventory observation missing');assert(observed.gameVersion===version,'Bridge observation game version mismatch');await fs.writeFile(path.join(directory,'observation.json'),JSON.stringify(observed,null,2));result.scenarios.observe='pass';
    const hotbar=await api('hotbar',{slot:7});assert(hotbar.selectedSlot===7&&(await api('observe')).player.selectedSlot===7,'Selected hotbar did not change');result.hotbar='pass';
    scenario('move');await api('look',{yaw:0,pitch:0});await api('input',{key:'forward',durationMs:500});await sleep(850);const moved=await api('observe');assert(distance(initial.player,moved.player)>.2&&Math.abs(moved.player.y-100)<.2,'Actual horizontal movement missing');result.movement={before:initial.player,after:moved.player};result.scenarios.move='pass';
    scenario('command');await api('command',{text:'tp @s 3.5 100 0.5'});await until(async()=>{const s=await status();return s.player&&distance(s.player,{x:3.5,y:100,z:.5})<.15;},12000,'player command result');result.scenarios.command='pass';
    scenario('interact');await admin('setblock 3 101 2 chest[facing=north]');await sleep(800);let chest;const attempts=[];
    for(let i=0;i<3&&!chest;i++){
      await api('stop');await api('command',{text:'tp @s 3.5 100 0.5'});await until(async()=>{const s=await status();return s.player&&distance(s.player,{x:3.5,y:100,z:.5})<.1;},5000,'chest pose');await api('look',{yaw:0,pitch:3.5});await api('input',{key:'use',durationMs:150});
      try{chest=await until(async()=>{const s=await status();return s.inventory?.slots?.length>46&&s.inventory.syncId>0?s:false;},4000,'chest GUI');}catch{const s=await api('observe');attempts.push({attempt:i+1,player:s.player,screen:s.screen});}
    }
    result.interactionAttempts=attempts;assert(chest,'Chest GUI missing after three attempts');await fs.writeFile(path.join(directory,'chest.json'),JSON.stringify(chest,null,2));await capture('chest-screen');await api('input',{key:'escape'});await sleep(300);result.scenarios.interact='pass';
    scenario('capture');result.capture=await capture('world-screen');result.nativeRendererVerified=true;result.scenarios.capture='pass';
    scenario('cancel');await api('look',{yaw:90,pitch:0});const before=await api('observe');await api('input',{key:'forward',durationMs:5000});await sleep(200);const held=await api('observe');assert(distance(before.player,held.player)>.1,'Cancellation fixture did not first move');await api('stop');await sleep(300);const stopped=await api('observe');await sleep(600);const after=await api('observe');assert(distance(stopped.player,after.player)<.12,'Motion continued after stop');result.cancel={before:before.player,held:held.player,stopped:stopped.player,after:after.player};result.scenarios.cancel='pass';await api('disconnect');
  }catch(error){error.scenario=current;throw error;}
  finally{
    if(client&&client.exitCode===null){const exited=new Promise(resolve=>client.once('exit',resolve));client.kill();await Promise.race([exited,sleep(10000).then(()=>{if(client.exitCode===null)throw new Error('Owned QA Minecraft client did not exit');})]);}
  }
}
