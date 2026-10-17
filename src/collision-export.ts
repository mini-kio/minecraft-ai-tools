import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {setTimeout as delay} from 'node:timers/promises';
import {BridgeService} from './bridges.js';
import {type Args,fail,finite} from './contracts.js';
import {registerCollisionDirectory} from './maps/native-collisions.js';
/** Acquire exact registry data from the user's matching game, without a version downgrade. */
export async function exportCollisionData(bridges:BridgeService,directory:string,args:Args):Promise<any>{
 const checkCancellation=()=>{if(args.signal?.aborted)fail('CANCELLED','Collision export cancelled');};
 checkCancellation();
 const timeoutMs=finite(args.timeoutMs??180000,'timeoutMs');if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)fail('INVALID_ARGUMENT','timeoutMs must be an integer 1..600000');
 const client=args.client||args.session,peer=bridges.peers.get(client);if(!peer||peer.kind!=='fabric')fail('CLIENT_REQUIRED','Pass --client ID for an attached Fabric companion');
 const deadline=Date.now()+timeoutMs;
 const start=await bridges.request(client,'collision-export',{operation:'start',...(args.contextBounds?{contextBounds:args.contextBounds}:{})});let completed=false;
 try{
  let result:any;
  for(;;){checkCancellation();if(Date.now()>deadline)fail('COLLISION_EXPORT_TIMEOUT','The game did not finish its incremental collision export');result=await bridges.request(client,'collision-export',{operation:'status',jobId:start.jobId});checkCancellation();if(result.state==='completed')break;if(['failed','cancelled'].includes(result.state))fail('COLLISION_EXPORT_FAILED',result.errorMessage||result.state);if(Date.now()>deadline)fail('COLLISION_EXPORT_TIMEOUT','The game did not finish its incremental collision export');await delay(Math.min(200,Math.max(1,deadline-Date.now())),undefined,{signal:args.signal});}
  result=await bridges.request(client,'collision-export',{operation:'status',jobId:start.jobId,includeGzip:true});checkCancellation();const bytes=Buffer.from(result.gzipBase64||'','base64'),sha256=createHash('sha256').update(bytes).digest('hex');if(bytes.length>32*1024*1024||sha256!==result.sha256)fail('COLLISION_INTEGRITY_FAILED','Native collision data checksum differs');
  const data=JSON.parse(gunzipSync(bytes,{maxOutputLength:128*1024*1024}).toString('utf8'));if(data.schemaVersion!==1||data.gameVersion!==peer.version||data.shapeContext!=='empty'||!Array.isArray(data.states)||!Array.isArray(data.defaultStates))fail('INVALID_COLLISION_DATA','Companion returned an incompatible collision dataset');
  if(!/^[0-9]+(?:\.[0-9]+){1,2}$/.test(data.gameVersion))fail('INVALID_COLLISION_DATA','Unsafe game version');
  checkCancellation();await fs.mkdir(directory,{recursive:true});checkCancellation();const file=path.join(directory,data.gameVersion+'.json.gz'),metadata={schemaVersion:1,gameVersion:data.gameVersion,sha256,source:'fabric-exact-game-registry',shapeContext:data.shapeContext,registryFingerprint:data.registryFingerprint,states:data.states.length,contextCases:data.contextCases?.length||0,observedAt:new Date().toISOString()};
  const temp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temp,bytes);checkCancellation();await fs.rename(temp,file);await fs.writeFile(file+'.metadata.json',JSON.stringify(metadata,null,2));}finally{await fs.unlink(temp).catch(()=>{});}
  registerCollisionDirectory(directory);completed=true;return{...metadata,path:file,exactGamePixels:false,contextCasesExhaustive:false,limitations:['Entity-sensitive and unobserved world-dependent shapes remain unknown.'],transport:'fabric-native-registry'};
 }catch(error){if(args.signal?.aborted)fail('CANCELLED','Collision export cancelled');throw error;
 }finally{if(!completed)await bridges.request(client,'collision-export',{operation:'cancel',jobId:start.jobId}).catch(()=>{});}
}
