import test from 'node:test';
import assert from 'node:assert/strict';
import {CollisionResolver,type MapReader} from '../src/maps/types.js';
import {nativeCollisionData} from '../src/maps/native-collisions.js';
import {checkInterior} from '../src/interior/index.js';

test('bundled exact latest native registry supplies ordinary offline shapes and native default states',async()=>{
  const resolver=new CollisionResolver('26.3');assert.equal(resolver.available,true);
  const stone=resolver.describe({name:'minecraft:stone',properties:{}});assert.deepEqual(stone.shapes,[[0,0,0,1,1,1]]);assert.equal(stone.collisionSource,'fabric-registry:26.3');
  const closed=resolver.describe({name:'minecraft:oak_door',properties:{open:'false'}}),open=resolver.describe({name:'minecraft:oak_door',properties:{open:'true'}});assert.notDeepEqual(closed.shapes,open.shapes);
  const stairs=resolver.describe({name:'minecraft:oak_stairs',properties:{}});assert(stairs.shapes&&stairs.shapes.length>1);
  const reader:MapReader={path:'fixture',kind:'fixture',dimension:'minecraft:overworld',version:'26.3',warnings:[],bounds:{min:{x:0,y:0,z:0},max:{x:5,y:3,z:4}},getBlock:async(_x,y)=>({name:y===0?'minecraft:stone':'minecraft:air',properties:{}}),metadata:()=>({}),changed:async()=>false,close:async()=>{}};
  const report=await checkInterior(reader,resolver,{bounds:reader.bounds,entry:{x:1.5,y:1,z:1.5},floors:[],targets:[{id:'room',position:{x:3.5,y:1,z:1.5}}]});assert.equal(report.targets[0].status,'reachable');
});
test('native contextual collision evidence is never reused at a different position or dimension',async()=>{
  const data=nativeCollisionData('26.3')!,example=data.cases.find(c=>c.state.name==='minecraft:bamboo');assert(example,'Latest runtime proof must contain a traced context fixture');
  const reader:MapReader={path:'fixture',kind:'fixture',dimension:example.dimension,version:'26.3',warnings:[],bounds:{min:{x:0,y:0,z:0},max:{x:300,y:200,z:500}},getBlock:async()=>example.state,metadata:()=>({}),changed:async()=>false,close:async()=>{}};
  const resolver=new CollisionResolver('26.3'),p=example.position;
  assert.deepEqual((await resolver.sample(reader,p.x,p.y,p.z)).shapes,example.shapes);
  assert.equal((await resolver.sample(reader,p.x+1,p.y,p.z)).shapes,null);
  reader.dimension='minecraft:the_nether';assert.equal((await resolver.sample(reader,p.x,p.y,p.z)).shapes,null);
  assert.equal(resolver.describe({name:'minecraft:powder_snow',properties:{}}).shapes,null);
});
