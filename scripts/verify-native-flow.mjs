#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Application } from '../dist/app.js';
const argv=process.argv.slice(2),opt=(key,fallback)=>{const index=argv.indexOf(key);return index<0?fallback:argv[index+1];};
const discovery=opt('--discovery');if(!discovery)throw new Error('--discovery FILE is required');
const stateDir=path.resolve(opt('--output','work/native-flow'));
await fs.mkdir(stateDir,{recursive:true});
const app=new Application({stateDir,artifactDir:path.join(stateDir,'artifacts')});
const evidence={startedAt:new Date().toISOString(),scenarios:{}};
let peer;
async function scenario(name,fn){const result=await fn();evidence.scenarios[name]={passed:true,result};process.stdout.write(`${name}: passed\n`);return result;}
async function ready(){for(let i=0;i<100;i++){const value=await app.execute('client','observe',{session:peer.id});if(value.connected&&!value.screen&&!value.loading)return value;await delay(200);}throw new Error('Client is not ready for gameplay');}
async function command(text){return app.execute('client','command',{session:peer.id,text});}
try{
  peer=await app.execute('client','attach',{path:discovery});await ready();
  for(const text of ['gamemode creative @s','fill 160 90 316 180 90 336 stone','fill 160 91 316 180 97 336 air','setblock 172 91 326 chest[facing=west]','setblock 165 92 329 stone','tp @s 169.5 91 326.5'])await command(text);
  await delay(500);
  const inspection={dimension:'minecraft:overworld',bounds:{min:{x:160,y:89,z:316},max:{x:180,y:94,z:336}},entry:{x:169.5,y:91,z:326.5},floors:[{id:'arena',cutY:92}],targets:[{id:'clear',position:{x:166.5,y:91,z:326.5}},{id:'chest-collision',position:{x:172.5,y:91,z:326.5}},{id:'headroom',position:{x:165.5,y:91,z:329.5}}]};
  await fs.writeFile(path.join(stateDir,'inspection.json'),JSON.stringify(inspection,null,2));
  await scenario('native-interior',async()=>{const r=await app.execute('interior','check',{client:peer.id,inspection});assert.equal(r.targets[0].status,'reachable');assert.equal(r.targets[1].status,'unreachable_in_profile');assert.equal(r.targets[2].status,'unreachable_in_profile');assert.equal(r.actualVisitVerified,false);return{reportPath:r.reportPath,targets:r.targets.map(t=>({id:t.id,status:t.status,failure:t.failure}))};});
  await scenario('physical-navigation',async()=>{const r=await app.execute('player','move',{session:peer.id,position:{x:166.5,y:91,z:326.5},bounds:inspection.bounds,timeoutMs:20000});assert.equal(r.liveVerified,true);assert(Math.abs(r.player.x-166.5)<.8);return{player:r.player,target:r.target};});
  await scenario('native-look-and-chest',async()=>{await app.execute('player','move',{session:peer.id,position:{x:169.5,y:91,z:326.5},bounds:inspection.bounds,timeoutMs:20000});const r=await app.execute('player','interact',{session:peer.id,position:{x:172,y:91,z:326},operation:'open'});assert(r.screen);const inventory=await app.execute('player','inventory',{session:peer.id,operation:'click',slot:0,mode:0});assert(inventory.slots.length>40);const image=await app.execute('capture','capture',{session:peer.id});assert(image.imagePath);await app.execute('player','inventory',{session:peer.id,operation:'close'});await ready();return{screen:r.screen,imagePath:image.imagePath};});
  await scenario('cancel-before-navigation',async()=>{const job=await app.execute('player','move',{session:peer.id,position:{x:166.5,y:91,z:326.5},bounds:inspection.bounds,timeoutMs:20000,async:true});await app.execute('job','cancel',{job:job.id});await delay(400);const a=await app.execute('observe','observe',{session:peer.id});await delay(400);const b=await app.execute('observe','observe',{session:peer.id});assert(Math.hypot(a.player.x-b.player.x,a.player.z-b.player.z)<.1);return{job:await app.execute('job','status',{job:job.id}),before:a.player,after:b.player};});
  await scenario('native-tour',async()=>{const plan={...inspection,targets:[{id:'west',position:{x:166.5,y:91,z:326.5}},{id:'south',position:{x:166.5,y:91,z:329.5},lookAt:{x:172.5,y:91.5,z:326.5}}]};const r=await app.execute('interior','tour',{player:peer.id,inspection:plan,timeoutMs:20000});assert.equal(r.tour.length,2);assert(r.tour.every(t=>t.liveVerified&&t.captures.length===4&&t.captures.every(c=>c.imagePath)));return{reportPath:r.reportPath,tour:r.tour.map(t=>({id:t.id,liveVerified:t.liveVerified,images:t.captures.map(c=>c.imagePath)}))};});
  evidence.passed=true;
}catch(error){evidence.passed=false;evidence.error=String(error.stack||error);process.exitCode=1;console.error(evidence.error);}
finally{evidence.finishedAt=new Date().toISOString();await fs.writeFile(path.join(stateDir,'evidence.json'),JSON.stringify(evidence,null,2));await app.close();}
