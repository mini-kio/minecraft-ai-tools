#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import assert from 'node:assert/strict';
import {setTimeout as sleep} from 'node:timers/promises';
import {Application} from '../dist/app.js';
const argv=process.argv.slice(2),opt=(key,fallback)=>{const i=argv.indexOf(key);return i<0?fallback:argv[i+1];};
if(!argv.includes('--accept-eula'))throw new Error('--accept-eula is required to create the isolated copy server');
const world=path.resolve(opt('--world')),stateDir=path.resolve(opt('--output','work/native-stage'));
await fs.mkdir(stateDir,{recursive:true});
const app=new Application({stateDir,artifactDir:path.join(stateDir,'artifacts')});
const evidence={startedAt:new Date().toISOString(),checks:{}};let client;
async function command(text){return app.execute('client','command',{session:client.id,text});}
async function until(fn,label){for(let i=0;i<120;i++){const value=await fn();if(value)return value;await sleep(250);}throw new Error(`Timeout: ${label}`);}
async function hashTree(directory){const files={};async function visit(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())await visit(full);else if(entry.isFile()&&entry.name!=='session.lock')files[path.relative(directory,full)]=crypto.createHash('sha256').update(await fs.readFile(full)).digest('hex');}}await visit(directory);return files;}
try{
  client=await app.execute('client','attach',{path:opt('--discovery')});
  if(!argv.includes('--stage-only')){
  await until(async()=>{const r=await app.execute('client','observe',{session:client.id});return r.connected&&!r.screen&&!r.loading&&r;},'playable client');
  await command('tp @s 169.5 91 326.5');await command('item replace block 172 91 326 container.0 with minecraft:diamond 3');await sleep(500);
  const chest=await app.execute('player','interact',{session:client.id,position:{x:172,y:91,z:326},operation:'open'});
  await until(async()=>{const r=await app.execute('client','observe',{session:client.id});return r.inventory?.slots[0]?.count===3&&r;},'chest diamonds');
  await app.execute('client','gui',{session:client.id,type:'click',button:1,x:chest.screen.width/2-72,y:chest.screen.height/2-57});
  await until(async()=>{const r=await app.execute('client','observe',{session:client.id});return r.inventory?.slots[0]?.count===1;},'portable right click removes half the stack');
  await app.execute('player','inventory',{session:client.id,slot:0,mode:0,operation:'click'});
  await until(async()=>{const r=await app.execute('client','observe',{session:client.id});return r.inventory?.slots[0]?.count===3;},'explicit inventory restores stack');
  evidence.checks.portableRightClick=true;await app.execute('player','inventory',{session:client.id,operation:'close'});
  await command('save-all flush');await sleep(300);await command('stop');
  await until(async()=>{const r=await app.execute('client','observe',{session:client.id});return !r.connected;},'source QA server stops');
  await app.execute('client','disconnect',{session:client.id});await sleep(1500);
  } else { const status=await app.execute('client','observe',{session:client.id});assert.equal(status.connected,false,'Stage-only QA requires the source server already stopped and the client disconnected'); }
  const before=await hashTree(world);
  const opened=await app.execute('map','open',{path:world,version:client.version});
  const staged=await app.execute('map','stage',{session:opened.session,client:client.id,acceptEula:true,javaPath:opt('--java-path'),memoryMb:1024});
  assert.equal(staged.originalWorldModified,false);evidence.checks.worldCopyStage=true;
  const camera=await app.execute('map','camera',{session:opened.session,position:{x:168,y:96,z:332},target:{x:170,y:91,z:326}});
  assert.equal(camera.cameraMode,'spectator-in-world-copy');
  const capture=await app.execute('map','capture',{session:opened.session});assert.equal(capture.source,'minecraft-client');assert(capture.imagePath);evidence.checks.realSpectatorCameraAndCapture=true;evidence.imagePath=capture.imagePath;
  await app.execute('map','close',{session:opened.session});
  const after=await hashTree(world);assert.deepEqual(after,before);evidence.checks.sourceWorldUnchanged=true;evidence.sourceFiles=Object.keys(before).length;evidence.sourceWorld=world;evidence.staged=staged.native;evidence.passed=true;
  console.log(JSON.stringify({passed:true,checks:evidence.checks,imagePath:evidence.imagePath,sourceFiles:evidence.sourceFiles}));
}catch(error){evidence.passed=false;evidence.error=String(error.stack||error);process.exitCode=1;console.error(evidence.error);}
finally{evidence.finishedAt=new Date().toISOString();await fs.writeFile(path.join(stateDir,'evidence.json'),JSON.stringify(evidence,null,2));await app.close();}
