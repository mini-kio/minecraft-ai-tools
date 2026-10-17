import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { ServerService } from '../dist/servers/index.js';
import { PlayerService } from '../dist/players/index.js';

if(!process.argv.includes('--accept-eula'))throw new Error('Pass --accept-eula for isolated player cancellation QA');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), directory=path.join(root,'work/player-cancellation-live');
await fs.mkdir(directory,{recursive:true});
const runtimes=JSON.parse(await fs.readFile(path.join(root,'work/paper-qa/runtimes/runtimes.json'),'utf8'));
const servers=new ServerService({stateDir:directory,artifactDir:directory}), players=new PlayerService({stateDir:directory,artifactDir:path.join(directory,'images')});
const evidence={startedAt:new Date().toISOString(),version:'1.21.4',checks:{}};
const assert=(value,message)=>{if(!value)throw new Error(message);};
async function cancelled(operation){try{await operation;throw new Error('Operation returned success after abort');}catch(error){assert(error.code==='CANCELLED','Expected CANCELLED, got '+(error.code||error.message));}}
try{
  let server=(await servers.call('list')).sessions.find(s=>s.version===evidence.version&&s.software==='vanilla');server||=await servers.call('create',{version:evidence.version,acceptEula:true});
  await servers.call('start',{session:server.sessionId,javaPath:runtimes[21].java,memoryMb:1024,wait:true});
  const args={version:evidence.version,host:'127.0.0.1',port:server.port,username:'MCTCancelQA'}, connectController=new AbortController();
  const connecting=players.call('connect',{...args,signal:connectController.signal});connectController.abort();await cancelled(connecting);
  assert((await players.call('list')).sessions.length===0,'Aborted connection remained registered');evidence.checks.connectionAbortRemovedOwnedBot=true;
  const connected=await players.call('connect',args), session=connected.sessionId;
  const admin=text=>servers.call('command',{session:server.sessionId,text});
  for(const text of ['forceload add -8 -8 8 8','fill -8 99 -8 8 99 8 stone','fill -8 100 -8 8 105 8 air','tp MCTCancelQA 0.5 100 0.5'])await admin(text);await sleep(1000);
  const moveController=new AbortController(), moving=players.call('move',{session,controls:['forward'],durationMs:5000,signal:moveController.signal});await sleep(200);moveController.abort();await cancelled(moving);
  await sleep(400);const stopped=(await players.call('observe',{session})).position;await sleep(500);const after=(await players.call('observe',{session})).position;
  assert(Math.hypot(stopped.x-after.x,stopped.y-after.y,stopped.z-after.z)<.12,'Inputs remained active after abort');evidence.checks.movementAbortReleasedInputs=true;
  const before=await fs.readdir(path.join(directory,'images')).catch(()=>[]), captureController=new AbortController();
  const capture=players.call('capture',{session,width:320,height:240,signal:captureController.signal});await sleep(200);captureController.abort();await cancelled(capture);
  assert(JSON.stringify(await fs.readdir(path.join(directory,'images')).catch(()=>[]))===JSON.stringify(before),'Partial capture files remained');evidence.checks.captureAbortCleanedArtifacts=true;
  const recovered=await players.call('capture',{session,width:320,height:240,timeoutMs:45000});assert((await fs.stat(recovered.imagePath)).size>1000,'Capture could not recover after abort');evidence.recoveryCapture=recovered;evidence.checks.captureSessionReusable=true;
  await admin('tp MCTCancelQA 2.5 100 0.5');await admin('setblock 3 100 0 chest');await sleep(300);
  const interactController=new AbortController(), opening=players.call('interact',{session,position:{x:3,y:100,z:0},operation:'open',signal:interactController.signal});interactController.abort();await cancelled(opening);
  assert((await players.call('observe',{session})).state==='disconnected','Cancelled open left a connected protocol session');evidence.checks.interactionAbortClosedOwnedConnection=true;
  evidence.status='passed';
}catch(error){evidence.status='failed';evidence.error={code:error.code,message:error.message,stack:error.stack};process.exitCode=1;}
finally{for(const service of [players,servers])try{await service.close();}catch(error){evidence.status='failed';evidence.cleanupErrors??=[];evidence.cleanupErrors.push({code:error.code,message:error.message});process.exitCode=1;}evidence.finishedAt=new Date().toISOString();await fs.writeFile(path.join(directory,'evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));}
