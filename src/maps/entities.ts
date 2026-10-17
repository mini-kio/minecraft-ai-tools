import {createHash} from 'node:crypto';
import {fail} from '../contracts.js';
import type {Bounds,Point,MapEntity,MapBlockEntity} from './types.js';

export type NbtTag={type:string;value:any};
export const tag=(type:string,value:any):NbtTag=>({type,value});
export const nbtList=(type:string,value:any[]):NbtTag=>tag('list',{type,value});
export function nbtValue(value:any):any{
  if(!value)return undefined;
  if(value.type==='compound')return Object.fromEntries(Object.entries(value.value).map(([k,v])=>[k,nbtValue(v)]));
  if(value.type==='list')return value.value.value.map((v:any)=>nbtValue(value.value.type==='compound'&&Object.keys(v).length===1&&Object.hasOwn(v,'')?v['']:tag(value.value.type,v)));
  return value.value;
}
export function nbtItems(value:any):NbtTag[]{return value?.type==='list'?value.value.value.map((v:any)=>value.value.type==='compound'&&Object.keys(v).length===1&&Object.hasOwn(v,'')?v['']:tag(value.value.type,v)):[];}
function vector(value:any,name:string):Point{const a=nbtValue(value);if(!Array.isArray(a)||a.length!==3||!a.every(Number.isFinite))fail('INVALID_ENTITY',`${name} must contain three finite coordinates`);return{x:a[0],y:a[1],z:a[2]};}
const add=(a:Point,b:Point):Point=>({x:a.x+b.x,y:a.y+b.y,z:a.z+b.z});
const subtract=(a:Point,b:Point):Point=>({x:a.x-b.x,y:a.y-b.y,z:a.z-b.z});
const positionTag=(p:Point)=>nbtList('double',[p.x,p.y,p.z]);
function uuid(value:any):string|undefined{
  const raw=nbtValue(value);if(typeof raw==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw))return raw.toLowerCase();
  if(value?.type==='intArray'&&raw.length===4){const h=raw.map((n:number)=>(n>>>0).toString(16).padStart(8,'0')).join('');return[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');}
}
function uuidTag(id:string):NbtTag{const h=id.replaceAll('-','');return tag('intArray',Array.from({length:4},(_,i)=>Number.parseInt(h.slice(i*8,i*8+8),16)|0));}
function oldUuid(value:any):string|undefined{const fields=value?.value;if(!fields?.UUIDMost||!fields.UUIDLeast)return;const long=(v:any)=>Array.isArray(v)?(BigInt(v[0]>>>0)<<32n)|BigInt(v[1]>>>0):BigInt.asUintN(64,BigInt(v));const n=(long(fields.UUIDMost.value)<<64n)|long(fields.UUIDLeast.value),h=n.toString(16).padStart(32,'0');return[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');}
export interface SourceEntity {id:string;position:Point;blockPosition?:Point;nbt:NbtTag;passengers:SourceEntity[];sourceUuid?:string;importTags?:string[];}
/** Read the source's coordinate wrapper separately from saved (possibly absolute) entity NBT. */
export function parseMapEntities(root:NbtTag,kind:string,origin:Point,maximum=4096):SourceEntity[]{
  const container=root.value.Schematic??root,items=kind==='structure'?nbtItems(root.value.entities):nbtItems(container.value.Entities),result:SourceEntity[]=[];let count=0;
  const parse=(data:NbtTag,p:Point,delta:Point,anchor:Point|undefined,depth:number):SourceEntity=>{
    if(++count>maximum||depth>32)fail('TOO_MANY_ENTITIES','Entity import exceeds 4096 entries or 32 passenger levels');
    if(data.type!=='compound')fail('INVALID_ENTITY','Entity NBT must be a compound');
    const copy=structuredClone(data),fields=copy.value,id=String(nbtValue(fields.id??fields.Id)??'');
    if(!/^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(id)||id==='minecraft:player')fail('INVALID_ENTITY','Entity must have a summonable namespaced type',{id});
    fields.id=tag('string',id);delete fields.Id;delete fields.ContentVersion;fields.Pos=positionTag(p);
    for(const axis of ['X','Y','Z']as const){const key='Tile'+axis;if(fields[key])fields[key]=tag('int',anchor?anchor[axis.toLowerCase()as keyof Point]:Number(fields[key].value)+delta[axis.toLowerCase()as keyof Point]);}
    if(fields.block_pos){const old=vector(fields.block_pos,'block_pos'),next=anchor??add(old,delta);fields.block_pos=tag('intArray',[next.x,next.y,next.z]);}
    for(const key of ['Leash','leash'])if(fields[key]?.type==='compound'){
      const leash=fields[key].value;if(['X','Y','Z'].every(k=>leash[k]))for(const axis of ['X','Y','Z']as const)leash[axis]=tag('int',Number(leash[axis].value)+delta[axis.toLowerCase()as keyof Point]);
      if(leash.block_pos){const next=add(vector(leash.block_pos,'leash.block_pos'),delta);leash.block_pos=tag('intArray',[next.x,next.y,next.z]);}
    }
    const passengers=nbtItems(fields.Passengers).map(child=>{const old=child.value?.Pos?vector(child.value.Pos,'Passenger Pos'):subtract(p,delta);return parse(child,add(old,delta),delta,undefined,depth+1);});
    if(passengers.length)fields.Passengers=nbtList('compound',passengers.map(child=>child.nbt.value));
    const rotation=nbtValue(fields.Rotation);if(rotation!==undefined&&(!Array.isArray(rotation)||rotation.length!==2||!rotation.every(Number.isFinite)))fail('INVALID_ENTITY','Rotation must contain finite yaw and pitch');
    return{id,position:p,blockPosition:anchor,nbt:copy,passengers,sourceUuid:uuid(data.value.UUID)??oldUuid(data)};
  };
  for(const item of items){
    if(item.type!=='compound')fail('INVALID_ENTITY','Entity wrapper must be a compound');
    const fields=item.value,data=kind==='structure'?fields.nbt:fields.Data??item;
    if(data?.type!=='compound')fail('INVALID_ENTITY','Entity payload must be a compound');
    const position=add(vector(kind==='structure'?fields.pos:fields.Pos,'Entity Pos'),origin),anchor=kind==='structure'&&fields.blockPos?add(vector(fields.blockPos,'Entity blockPos'),origin):undefined;
    const payload=structuredClone(data);if(!payload.value.id&&fields.Id)payload.value.id=fields.Id;
    const delta=data.value.Pos?subtract(position,vector(data.value.Pos,'Saved entity Pos')):origin;
    result.push(parse(payload,position,delta,anchor,0));
  }
  return result;
}
export function entityInBounds(entity:SourceEntity,bounds:Bounds):boolean{const p=entity.blockPosition??entity.position;return(['x','y','z']as const).every(k=>p[k]>=bounds.min[k]&&p[k]<bounds.max[k]+1);}
export function entityView(entity:SourceEntity):MapEntity{return{id:entity.id,position:entity.position,...(entity.blockPosition?{blockPosition:entity.blockPosition}:{}),...(entity.sourceUuid?{uuid:entity.sourceUuid}:{}),...(entity.nbt.value.Rotation?{rotation:nbtValue(entity.nbt.value.Rotation)}:{}),nbt:nbtValue(entity.nbt),passengers:entity.passengers.map(entityView)};}
export function parseMapBlockEntities(root:NbtTag,kind:string,origin:Point):MapBlockEntity[]{
  const out:MapBlockEntity[]=[],put=(data:NbtTag,position:Point,id?:string)=>{const value=nbtValue(data);out.push({id:id??value.id??value.Id??'minecraft:unknown_block_entity',position,nbt:value});};
  if(kind==='structure'){for(const item of nbtItems(root.value.blocks))if(item.value.nbt)put(item.value.nbt,add(vector(item.value.pos,'Block entity Pos'),origin));}
  else{const source=root.value.Schematic??root;for(const item of nbtItems(source.value.Blocks?.value.BlockEntities??source.value.BlockEntities??source.value.TileEntities))put(item.value.Data??item,add(vector(item.value.Pos,'Block entity Pos'),origin),nbtValue(item.value.Id));}
  return out;
}
export interface EntityImport {roots:SourceEntity[];flat:SourceEntity[];tag:string;excluded:number;uuidMap:Record<string,string>;}
export function prepareEntities(source:SourceEntity[],bounds:Bounds,seed:string):EntityImport{
  const roots=structuredClone(source.filter(entity=>entityInBounds(entity,bounds))),flat:SourceEntity[]=[],mapping=new Map<string,string>(),stageTag='mct_import_'+seed.replaceAll('-','');
  const visit=(entity:SourceEntity)=>{const i=flat.length,bytes=createHash('sha256').update(seed+':entity:'+i).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|0x40;bytes[8]=(bytes[8]&63)|128;const h=bytes.toString('hex'),next=[h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join('-');if(entity.sourceUuid){if(mapping.has(entity.sourceUuid))fail('DUPLICATE_ENTITY_UUID','Source contains duplicate entity UUIDs',{uuid:entity.sourceUuid});mapping.set(entity.sourceUuid,next);}entity.nbt.value.UUID=uuidTag(next);delete entity.nbt.value.UUIDMost;delete entity.nbt.value.UUIDLeast;const tags=nbtValue(entity.nbt.value.Tags)??[];if(!Array.isArray(tags)||tags.some(t=>typeof t!=='string'))fail('INVALID_ENTITY','Entity Tags must be a string list');entity.importTags=[stageTag,stageTag+'_'+i];entity.nbt.value.Tags=nbtList('string',[...new Set([...tags,...entity.importTags])]);flat.push(entity);entity.passengers.forEach(visit);};roots.forEach(visit);
  const remap=(value:NbtTag):NbtTag=>{const id=uuid(value),target=id&&mapping.get(id);if(target)return value.type==='string'?tag('string',target):uuidTag(target);if(value.type==='compound'){const fields=Object.fromEntries(Object.entries(value.value).map(([k,v])=>[k,remap(v as NbtTag)]));for(const key of Object.keys(fields))if(key.endsWith('Most')&&fields[key.slice(0,-4)+'Least']){const low=key.slice(0,-4)+'Least',old=oldUuid(tag('compound',{UUIDMost:fields[key],UUIDLeast:fields[low]})),next=old&&mapping.get(old);if(next){const hex=next.replaceAll('-',''),pair=(s:string)=>[Number.parseInt(s.slice(0,8),16)|0,Number.parseInt(s.slice(8),16)|0];fields[key]=tag('long',pair(hex.slice(0,16)));fields[low]=tag('long',pair(hex.slice(16)));}}return tag('compound',fields);}if(value.type==='list')return nbtList(value.value.type,value.value.value.map((v:any)=>remap(tag(value.value.type,v)).value));return value;};
  for(const entity of flat)entity.nbt=remap(entity.nbt);
  // Rebind passenger payloads after recursive UUID/reference rewriting.
  const rebind=(entity:SourceEntity)=>{entity.passengers.forEach(rebind);if(entity.passengers.length)entity.nbt.value.Passengers=nbtList('compound',entity.passengers.map(p=>p.nbt.value));};roots.forEach(rebind);
  return{roots,flat,tag:stageTag,excluded:source.length-roots.length,uuidMap:Object.fromEntries(mapping)};
}
/** Skeletons contain only safe identity/mount metadata; all rich data comes from binary storage. */
export function summonSkeleton(entity:SourceEntity):NbtTag{return tag('compound',{id:tag('string',entity.id),UUID:entity.nbt.value.UUID,Tags:nbtList('string',entity.importTags??[]),...(entity.passengers.length?{Passengers:nbtList('compound',entity.passengers.map(p=>summonSkeleton(p).value))}:{})});}
export function importedEntityUuid(entity:SourceEntity):string{return uuid(entity.nbt.value.UUID)!;}

