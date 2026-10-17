import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectNative } from '../src/native-interior.js';
import { NativeNavigation } from '../src/native-navigation.js';
const bounds = {min:{x:0,y:0,z:0},max:{x:5,y:3,z:4}};
function bridgeFixture() {
  const peers = new Map([['client',{id:'client',kind:'fabric',version:'26.3'}]]);
  return { peers, request: async (_id:string,action:string,args:any) => {
    if(action==='observe')return {connected:true,gameVersion:'26.3',dimension:'minecraft:overworld',player:{x:1.5,y:1,z:1.5}};
    const blocks=[];
    for(let x=args.min.x;x<=args.max.x;x++)for(let y=args.min.y;y<=args.max.y;y++)for(let z=args.min.z;z<=args.max.z;z++)blocks.push({position:{x,y,z},name:y===0?'example:native_floor':'minecraft:air',properties:{},known:true,shapes:y===0?[[0,0,0,1,1,1]]:[]});
    return {gameVersion:'26.3',dimension:'minecraft:overworld',tick:42,blocks};
  }};
}
test('latest native/custom collision shapes are consumed without depending on Prismarine version support',async()=>{
  const dir=await fs.mkdtemp(path.resolve('work/native-'));
  const report=await inspectNative(bridgeFixture() as any,{client:'client',inspection:{dimension:'minecraft:overworld',bounds,entry:{x:1.5,y:1,z:1.5},floors:[],targets:[{id:'customfloor',position:{x:3.5,y:1,z:1.5}}]}},dir);
  assert.equal(report.targets[0].status,'reachable');assert.equal(report.source,'minecraft-client-block-collisions');assert.equal(report.actualVisitVerified,false);
});
test('native navigation that receives no physical movement fails and releases held inputs',async()=>{
  let stopped=false;const fake={request:async(_id:string,action:string)=>{if(action==='stop')stopped=true;return {connected:true,player:{x:0,y:1,z:0}}}};
  const nav=new NativeNavigation(fake as any,'work');
  await assert.rejects(nav.follow('client',[{x:0,y:1,z:0},{x:3,y:1,z:0}],{timeoutMs:120}), (e:any)=>e.code==='TIMEOUT');assert.equal(stopped,true);
});

test('cancellation during native collision scanning cannot start delayed movement',async()=>{
  const fixture=bridgeFixture();const request=fixture.request;let scanned!:()=>void,release!:()=>void,pressed=false;
  const started=new Promise<void>(resolve=>{scanned=resolve;});const pending=new Promise<void>(resolve=>{release=resolve;});
  fixture.request=async(id,action,args)=>{if(action==='blocks'){scanned();await pending;}if(action==='input')pressed=true;return request(id,action,args);};
  const dir=await fs.mkdtemp(path.resolve('work/native-'));const nav=new NativeNavigation(fixture as any,dir);
  const movement=nav.move('client',{target:{x:3.5,y:1,z:1.5},bounds});
  await started;nav.cancel('client');release();
  await assert.rejects(movement,(e:any)=>e.code==='CANCELLED');assert.equal(pressed,false);
});
