import test from'node:test';import assert from'node:assert/strict';import{mkdtemp}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';import{Application}from'../src/app.js';
test('tour retains actual navigation failure coordinates for an AI repair',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mct-tour-diagnostic-')),app=new Application({stateDir:dir,artifactDir:dir}),details={position:{x:1.5,y:1,z:1},target:{x:2,y:1,z:1}};
 app.maps.call=async()=>({targets:[{id:'room',status:'reachable'}]});app.players.call=async()=>{throw Object.assign(Error('Client stopped making progress'),{code:'PATH_BLOCKED',details});};
 try{const report=await app.execute('interior','tour',{session:'map-fixture',player:'bot-fixture',inspection:{bounds:{min:{x:0,y:0,z:0},max:{x:4,y:4,z:4}},entry:{x:1,y:1,z:1},floors:[],targets:[{id:'room',position:details.target}]}});assert.equal(report.tour[0].liveVerified,false);assert.deepEqual(report.tour[0].error,{code:'PATH_BLOCKED',message:'Client stopped making progress',details});}finally{await app.close();}
});
test('staging rejects an excessive view distance before copying or starting a server',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'mct-view-distance-')),app=new Application({stateDir:dir,artifactDir:dir});let created=false;
 app.maps.call=async()=>({version:'26.3',dimension:'minecraft:overworld',path:'unreadable-source'});app.bridges.peers.set('client-fixture',{id:'client-fixture',kind:'fabric',name:'fixture',version:'26.3',capabilities:[]});app.bridges.request=async()=>({connected:false});app.servers.call=async()=>{created=true;return{}};
 try{for(const viewDistance of [1,33,Infinity,2.5])await assert.rejects(app.execute('map','stage',{session:'map-fixture',client:'client-fixture',viewDistance}),{code:'INVALID_ARGUMENT'});assert.equal(created,false);}finally{await app.close();}
});
