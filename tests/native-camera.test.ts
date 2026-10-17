import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Application} from '../src/app.js';

async function fixture(){
  const directory=await mkdtemp(path.join(tmpdir(),'mct-native-camera-')),app=new Application({stateDir:directory,artifactDir:path.join(directory,'artifacts')}),commands:string[]=[],looks:any[]=[];
  let teleported=false;
  app.nativeMaps.set('map-fixture',{client:'client-fixture',server:'server-fixture',source:'fixture',version:'26.3',dimension:'minecraft:overworld'} as any);
  app.servers.call=async(action,args)=>{assert.equal(action,'command');commands.push(args.text);teleported=true;return{};};
  app.bridges.request=async(_client,action,args)=>{if(action==='look'){looks.push(args);return{};}assert.equal(action,'observe');return{player:{name:'MctSmoke',...(teleported?{x:.5,y:80,z:.5}:{x:50,y:64,z:50})}};};
  return{app,commands,looks};
}
test('native camera aims from observed centered coordinates and standing eye height after teleport',async()=>{
  const f=await fixture(),target={x:10,y:81.62,z:5};
  try{
    const result=await f.app.execute('map','camera',{session:'map-fixture',position:{x:0,y:80,z:0},target});
    assert.deepEqual(f.commands,['execute in minecraft:overworld run tp MctSmoke 0 80 0']);assert.equal(f.looks.length,1);
    assert.equal(f.looks[0].yaw,Math.atan2(-9.5,4.5));assert.notEqual(f.looks[0].yaw,Math.atan2(-10,5));assert.equal(Math.abs(f.looks[0].pitch),0);
    assert.deepEqual(result.requestedPosition,{x:0,y:80,z:0});assert.deepEqual(result.actualPosition,{x:.5,y:80,z:.5});assert.deepEqual(result.eyePosition,{x:.5,y:81.62,z:.5});assert.equal(result.eyeHeight,1.62);assert.deepEqual(result.target,target);
  }finally{await f.app.close();}
});
test('native camera rejects a nonfinite target before teleporting or changing the view',async()=>{
  const f=await fixture();try{
    for(const target of [{x:Infinity,y:0,z:0},{x:0,y:NaN,z:0},{x:0,y:0}])await assert.rejects(f.app.execute('map','camera',{session:'map-fixture',position:{x:0,y:80,z:0},target}),{code:'INVALID_ARGUMENT'});
    assert.deepEqual(f.commands,[]);assert.deepEqual(f.looks,[]);
  }finally{await f.app.close();}
});
