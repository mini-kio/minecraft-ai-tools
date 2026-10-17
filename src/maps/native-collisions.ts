import {readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {fail} from '../contracts.js';
import type {BlockState,Shape} from './types.js';

function key(state:BlockState){return state.name+'['+Object.entries(state.properties||{}).sort().map(([k,v])=>k+'='+v).join(',')+']';}
export interface NativeCollisionData {version:string;fingerprint:string;defaults:Map<string,Record<string,string>>;states:Map<string,{shapes:Shape[]|null;reason?:string}>;cases:any[];}
const cached=new Map<string,{stamp:string;data:NativeCollisionData}>();
const extraDirectories=new Set<string>();
export function registerCollisionDirectory(directory:string):void{extraDirectories.add(path.resolve(directory));}
export function nativeCollisionData(version?:string):NativeCollisionData|undefined{
  if(!version||!/^[0-9]+(?:\.[0-9]+){1,2}$/.test(version))return;
  const candidates=[...extraDirectories].reverse().map(dir=>path.join(dir,version+'.json.gz'));
  candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../bridges/fabric/collision-data',version+'.json.gz'));
  const file=candidates.find(file=>{try{return statSync(file).isFile();}catch{return false;}});if(!file)return;
  let stat;try{stat=statSync(file);}catch{return;}
  const stamp=file+':'+stat.mtimeMs+':'+stat.size,previous=cached.get(version);if(previous?.stamp===stamp)return previous.data;
  const compressed=readFileSync(file),metadata=JSON.parse(readFileSync(file+'.metadata.json','utf8'));
  if(createHash('sha256').update(compressed).digest('hex')!==metadata.sha256)fail('COLLISION_INTEGRITY_FAILED','Bundled native collision dataset failed checksum',{version});
  const raw=JSON.parse(gunzipSync(compressed,{maxOutputLength:128*1024*1024}).toString('utf8'));
  if(raw.schemaVersion!==1||raw.gameVersion!==version||raw.shapeContext!=='empty')fail('INVALID_COLLISION_DATA','Collision dataset version or walking context differs',{version});
  const data:NativeCollisionData={version,fingerprint:raw.registryFingerprint,defaults:new Map(raw.defaultStates.map((state:any)=>[state.name,state.properties])),states:new Map(raw.states.map((state:any)=>[key(state),{shapes:state.shapes,reason:state.reason}])),cases:raw.contextCases||[]};
  cached.set(version,{stamp,data});return data;
}
export function nativeStateKey(state:BlockState){return key(state);}
export function defaultBlockProperties(version:string|undefined,name:string):Record<string,string>{return nativeCollisionData(version)?.defaults.get(name)||{};}
