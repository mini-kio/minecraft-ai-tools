#!/usr/bin/env node
/** Independently audit recorded final-artifact evidence; never launches a game. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2),index=args.indexOf('--output'),output=path.resolve(index>=0?args[index+1]:path.join(root,'work/fabric-runtime-legacy/expanded'));
const compatibility=JSON.parse(await fs.readFile(path.join(root,'bridges/fabric/compatibility.json'),'utf8')),results=[],partial=args.includes('--partial'),aggregate=partial?JSON.parse(await fs.readFile(path.join(output,'results.json'),'utf8')):undefined,completed=new Set(aggregate?.versions.filter(v=>v.runtimeVerified&&v.finishedAt).map(v=>v.version)||[]),targets=compatibility.versions.filter(v=>/^1\./.test(v.version));
const hash=data=>createHash('sha256').update(data).digest('hex'),distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z),read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
for(const entry of targets.filter(v=>!partial||completed.has(v.version))){const errors=[],checks={},images=[];const assert=(key,condition)=>{checks[key]=Boolean(condition);if(!condition)errors.push(key);};const dir=path.join(output,entry.version);try{
  const r=await read(path.join(dir,'result.json')),actual=hash(await fs.readFile(path.join(root,entry.artifact)));
  assert('currentArtifact',r.artifactSha256===actual&&actual===entry.sha256);assert('runtimeVerified',r.runtimeVerified===true);
  assert('core7',['connect','observe','move','command','interact','capture','cancel'].every(k=>r.runtimeScenarios[k]==='pass'));
  assert('additionalGui',['hotbar','guiLeftClick','guiRightClick','guiUnicodeChat'].every(k=>r.additionalScenarios?.[k]==='pass'));
  const observed=await read(path.join(dir,'world-observation.json')),chest=await read(path.join(dir,'chest-observation.json')),cancel=await read(path.join(dir,'cancel-observation.json')),hotbar=await read(path.join(dir,'hotbar-observation.json')),gui=await read(path.join(dir,'gui-click-observation.json')),chat=await read(path.join(dir,'unicode-chat-observation.json'));
  assert('worldInventory',observed.connected&&observed.source==='fabric-client'&&observed.inventory.slots.length>=36);
  assert('chestMenu',chest.screen&&chest.inventory.syncId>0&&chest.inventory.slots.length>46);
  assert('actualFloorMovement',distance(r.movement.before,r.movement.after)>.2&&Math.abs(r.movement.before.y-100)<.2&&Math.abs(r.movement.after.y-100)<.2);
  assert('initialCancelMotion',distance(cancel.before.player,cancel.held.player)>.1);assert('releasedCancelMotion',distance(cancel.stopped.player,cancel.after.player)<.12);
  assert('hotbarTelemetry',hotbar.pass&&JSON.stringify(hotbar.selections.map(v=>v.slot))==='[0,7,0]'&&hotbar.selections.every(v=>v.result.selectedSlot===v.slot&&v.playerSlot===v.slot&&v.inventorySlot===v.slot));
  assert('invalidHotbarRejected',JSON.stringify(hotbar.invalidRejected)==='[-1,9,1.5]');assert('actualGuiButtons',gui.pass&&gui.leftClick.handled&&gui.rightClick.handled&&gui.restoredCount===3);
  assert('unicodeTyped',chat.pass&&chat.accepted===Array.from(chat.text).length&&/[가-힣]/.test(chat.text));const serverLog=await fs.readFile(path.join(r.server.directory,'mct-output.log'),'utf8');assert('unicodeReachedServer',serverLog.includes(chat.text));
  for(const name of ['title-screen','chest-screen','world-screen','unicode-chat-screen']){const bytes=await fs.readFile(path.join(dir,name+'.png')),meta=await read(path.join(dir,name+'.json'));assert(name+'NativePng',bytes.length>512&&bytes.subarray(1,4).toString()==='PNG'&&meta.source==='fabric-game-framebuffer'&&meta.captureFrame>0);images.push({file:name+'.png',sha256:hash(bytes),width:meta.width,height:meta.height});}
}catch(error){errors.push(error.message);}results.push({version:entry.version,passed:!errors.length,checks,errors,images});}
const report={generatedAt:new Date().toISOString(),scope:partial?'Completed evidence only; all-version verification stopped at user request':'All legacy targets',partial,totalTargets:targets.length,unverifiedVersions:targets.filter(v=>!results.some(r=>r.version===v.version&&r.passed)).map(v=>v.version),versions:results.length,passed:results.filter(r=>r.passed).length,failed:results.filter(r=>!r.passed).length,results};await fs.writeFile(path.join(output,'audit.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({scope:report.scope,versions:report.versions,passed:report.passed,failed:report.failed,unverifiedVersions:report.unverifiedVersions,failures:results.filter(r=>!r.passed).map(r=>({version:r.version,errors:r.errors}))}));if(report.failed)process.exitCode=1;
