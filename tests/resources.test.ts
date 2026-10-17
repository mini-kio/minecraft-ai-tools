import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {AssetArchive,ResourceManager,bakeModel,matchesWhen,normalizeTextureAnimation,textureFrameAt,weightedVariantIndex} from '../src/resources.js';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{PNG}=require('pngjs');
const sides=['up','down','north','south','east','west'];
const cube=(texture='#all')=>({elements:[{from:[0,0,0],to:[16,16,16],faces:Object.fromEntries(sides.map(s=>[s,{texture}]))}]});
async function put(root:string,name:string,value:any){const file=join(root,name);await mkdir(dirname(file),{recursive:true});await writeFile(file,Buffer.isBuffer(value)?value:JSON.stringify(value));}
async function fixture(version='1.20'){const root=await mkdtemp(join(tmpdir(),'mct-assets-')),base=join(root,'base'),pack=join(root,'pack');await mkdir(base);await mkdir(pack);await put(base,'version.json',{id:version});return{root,base,pack,manager:new ResourceManager(join(root,'state'))};}
const blocks=(version:string,properties:Record<string,string>={},name='minecraft:stone')=>({version,blocks:[{name,properties,position:{x:0,y:0,z:0}}]});

test('resource model parent geometry and texture references obey last-pack precedence and folder reload',async()=>{const f=await fixture();await put(f.base,'assets/minecraft/blockstates/stone.json',{variants:{'':{model:'fixture:block/child'}}});await put(f.base,'assets/fixture/models/block/parent.json',{...cube('#side'),textures:{all:'fixture:block/base',side:'#all'}});await put(f.base,'assets/fixture/models/block/child.json',{parent:'fixture:block/parent'});await put(f.base,'assets/fixture/textures/block/base.png',Buffer.from('base texture'));await put(f.pack,'assets/fixture/models/block/child.json',{parent:'fixture:block/parent',textures:{all:'fixture:block/overridden'}});await put(f.pack,'assets/fixture/textures/block/overridden.png',Buffer.from('override texture'));const result=await f.manager.prepare(blocks('1.20'),{assetsJar:f.base,resourcePack:f.pack});assert.equal(result.models['minecraft:stone'].length,6);assert.ok(result.models['minecraft:stone'].every(face=>face.texture==='fixture:block/overridden'));assert.equal(Buffer.from(result.textures['fixture:block/overridden'].url.split(',')[1],'base64').toString(),'override texture');const second=join(f.root,'second');await put(second,'assets/fixture/textures/block/overridden.png',Buffer.from('top pack'));const top=await f.manager.prepare(blocks('1.20'),{assetsJar:f.base,resourcePacks:[f.pack,second]});assert.equal(Buffer.from(top.textures['fixture:block/overridden'].url.split(',')[1],'base64').toString(),'top pack');await put(second,'assets/fixture/textures/block/overridden.png',Buffer.from('edited in place'));const edited=await f.manager.prepare(blocks('1.20'),{assetsJar:f.base,resourcePacks:[f.pack,second]});assert.equal(Buffer.from(edited.textures['fixture:block/overridden'].url.split(',')[1],'base64').toString(),'edited in place');});

test('default omitted block properties select exact-version variant while retaining viewer key',async()=>{for(const version of ['1.20','26.3']){const f=await fixture(version);await put(f.base,'assets/minecraft/blockstates/oak_stairs.json',{variants:{'facing=north,half=bottom,shape=straight,waterlogged=false':{model:'fixture:block/stair'}}});await put(f.base,'assets/fixture/models/block/stair.json',{...cube(),textures:{all:'fixture:block/a'}});await put(f.base,'assets/fixture/textures/block/a.png',Buffer.from('texture'));const result=await f.manager.prepare(blocks(version,{},'minecraft:oak_stairs'),{assetsJar:f.base});assert.ok(result.models['minecraft:oak_stairs']?.length,`missing default-state model for ${version}`);}});

test('multipart OR/AND conditions combine applicable geometry and support alternatives',async()=>{const f=await fixture();await put(f.base,'assets/minecraft/blockstates/stone.json',{multipart:[{apply:{model:'fixture:block/a'}},{when:{OR:[{north:'true'},{south:'true'}]},apply:{model:'fixture:block/b'}},{when:{AND:[{east:'false'},{height:'low|mid'}]},apply:{model:'fixture:block/c'}}]});for(const id of ['a','b','c']){await put(f.base,`assets/fixture/models/block/${id}.json`,{...cube(),textures:{all:`fixture:block/${id}`}});await put(f.base,`assets/fixture/textures/block/${id}.png`,Buffer.from(id));}const result=await f.manager.prepare(blocks('1.20',{north:'false',south:'true',east:'false',height:'high'}),{assetsJar:f.base});const faces=Object.values(result.models)[0];assert.equal(faces.length,12);assert.ok(faces.some(face=>face.texture==='fixture:block/b'));assert.ok(!faces.some(face=>face.texture==='fixture:block/c'));assert.equal(matchesWhen({AND:[{x:'a|b'},{y:'c'}]},{x:'b',y:'c'}),true);});
test('multipart negation follows the 1.21.5 Terms parser change',()=>{const when={facing:'!north|south'},south={facing:'south'};assert.equal(matchesWhen(when,south,'1.20'),false);assert.equal(matchesWhen(when,south,'1.21.4'),false);assert.equal(matchesWhen(when,south,'1.21.5'),true);assert.equal(matchesWhen(when,south,'26.3'),true);assert.equal(matchesWhen({OR:[when,{half:'top'}]},{...south,half:'bottom'},'1.20'),false);});

test('UV lock retains world-space cube orientation for x/y/combined quarter turns',()=>{const model=cube('fixture:a'),key=(value:number[])=>value.map(n=>Math.round(n*1e6)/1e6).join(',');function normal(face:any){const p=face.positions,a=[p[3]-p[0],p[4]-p[1],p[5]-p[2]],b=[p[6]-p[0],p[7]-p[1],p[8]-p[2]];return key([a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]);}const canonical=new Map<string,string>();for(const face of bakeModel(model,{},id=>id))for(let i=0;i<6;i++)canonical.set(normal(face)+'|'+key(face.positions.slice(i*3,i*3+3)),key(face.uv.slice(i*2,i*2+2)));for(const variant of [{x:90},{y:90},{x:90,y:90},{x:180,y:270}])for(const face of bakeModel(model,{...variant,uvlock:true},id=>id))for(let i=0;i<6;i++)assert.equal(key(face.uv.slice(i*2,i*2+2)),canonical.get(normal(face)+'|'+key(face.positions.slice(i*3,i*3+3))),JSON.stringify(variant));});
test('face UV rotation follows the positive Vanilla shifted vertex index',()=>{const expected=new Map([[0,[0,1]],[90,[0,0]],[180,[1,0]],[270,[1,1]]]);for(const[rotation,uv]of expected){const model={elements:[{from:[0,0,0],to:[16,16,16],faces:{north:{texture:'fixture:a',uv:[0,0,16,16],rotation}}}]};assert.deepEqual(bakeModel(model,{},id=>id)[0].uv.slice(0,2),uv,`rotation ${rotation}`);}});
test('UV-lock transforms authored partial rectangles like Vanilla recomputeUVs',()=>{const expected=new Map([[90,[[1,1],[0,1],[0,.5],[1,.5]]],[180,[[1,0],[1,1],[.5,1],[.5,0]]],[270,[[0,0],[1,0],[1,.5],[0,.5]]]]);for(const[y,corners]of expected){const element={from:[0,0,0],to:[8,16,16],faces:{up:{texture:'fixture:a',uv:[0,0,8,16]}}},want=[0,1,2,0,2,3].flatMap(i=>corners[i]),actual=bakeModel({elements:[element]},{y,uvlock:true},id=>id)[0].uv;assert.deepEqual(actual.map(n=>Math.round(n*1e6)/1e6),want,`partial y=${y}`);const rotated={...element,rotation:{axis:'x',angle:45,origin:[8,8,8]}};assert.deepEqual(bakeModel({elements:[rotated]},{y,uvlock:true},id=>id)[0].uv.map(n=>Math.round(n*1e6)/1e6),want,`element rotation must not alter UV lock y=${y}`);}});

test('element rotation/rescale is local to its origin and inherited model cycles fail clearly',async()=>{const baked=bakeModel({elements:[{from:[0,0,0],to:[16,16,16],rotation:{axis:'y',angle:45,origin:[8,8,8],rescale:true},faces:{north:{texture:'fixture:a'}}}]},{},id=>id);assert.ok(baked[0].positions.every(Number.isFinite));assert.ok(baked[0].positions.some(n=>n<0||n>1));const f=await fixture();await put(f.base,'assets/minecraft/blockstates/stone.json',{variants:{'':{model:'fixture:block/a'}}});await put(f.base,'assets/fixture/models/block/a.json',{parent:'fixture:block/b'});await put(f.base,'assets/fixture/models/block/b.json',{parent:'fixture:block/a'});await assert.rejects(()=>f.manager.prepare(blocks('1.20'),{assetsJar:f.base}),(e:any)=>e.code==='RESOURCE_PARENT_CYCLE');});

test('asset reads reject traversal and exact-version mismatch',async()=>{const f=await fixture();const archive=await AssetArchive.open(f.pack);await assert.rejects(()=>archive.read('assets/minecraft/models/../../secrets.json'),(e:any)=>e.code==='INVALID_ASSET_PATH');await assert.rejects(()=>f.manager.prepare(blocks('26.3'),{assetsJar:f.base}),(e:any)=>e.code==='ASSET_VERSION_MISMATCH');});

test('Java animation frames obey authored order, individual durations, 20Hz interpolation and wrapping',()=>{
  const animation=normalizeTextureAnimation({frametime:4,frames:[2,{index:0,time:2},1],interpolate:true},2,6);
  assert.deepEqual(animation.frames,[{index:2,durationMs:200},{index:0,durationMs:100},{index:1,durationMs:200}]);
  assert.deepEqual(textureFrameAt(animation,50),{index:2,nextIndex:0,progress:.25});
  assert.deepEqual(textureFrameAt(animation,99),textureFrameAt(animation,50));
  assert.deepEqual(textureFrameAt(animation,200),{index:0,nextIndex:1,progress:0});
  assert.deepEqual(textureFrameAt(animation,500),{index:2,nextIndex:0,progress:0});
  assert.equal(normalizeTextureAnimation({width:2},4,6).frameHeight,6);
  assert.equal(normalizeTextureAnimation({height:3},4,6).frameWidth,4);
  assert.throws(()=>normalizeTextureAnimation({frames:[3]},2,6),{code:'INVALID_TEXTURE_ANIMATION'});
  assert.throws(()=>normalizeTextureAnimation({frametime:0},2,6),{code:'INVALID_TEXTURE_ANIMATION'});
  assert.throws(()=>normalizeTextureAnimation({width:3},4,6),{code:'INVALID_TEXTURE_ANIMATION'});
});
test('weighted preview variants are position-stable, respect unequal weights and do not always select first',()=>{
  const variants=[{weight:1},{weight:3}],positions=Array.from({length:256},(_,x)=>({x:x-128,y:64,z:7}));
  const first=positions.map(p=>weightedVariantIndex(variants,p,'fixture')),second=[...positions].reverse().map(p=>weightedVariantIndex(variants,p,'fixture')).reverse();
  assert.deepEqual(first,second);const count=first.filter(i=>i===1).length;assert.ok(count>160&&count<225,`3:1 weight unexpectedly selected ${count}/256`);
  assert.throws(()=>weightedVariantIndex([{weight:0}],positions[0]),{code:'INVALID_RESOURCE_MODEL'});
});
function animationPng(){const image=new PNG({width:2,height:4});for(let i=0;i<8;i++){const o=i*4;image.data[o]=i<4?255:0;image.data[o+2]=i<4?0:255;image.data[o+3]=255;}return PNG.sync.write(image);}
test('26.3 prepared packets select weighted geometry per position and retain only winning PNG metadata',async()=>{
  const f=await fixture('26.3');await put(f.base,'assets/minecraft/blockstates/stone.json',{variants:{'':[{model:'fixture:block/a',weight:1},{model:'fixture:block/b',weight:3}]}});
  for(const id of ['a','b'])await put(f.base,`assets/fixture/models/block/${id}.json`,{...cube(),textures:{all:'fixture:block/animated'}});
  await put(f.base,'assets/fixture/textures/block/animated.png',animationPng());await put(f.base,'assets/fixture/textures/block/animated.png.mcmeta',{animation:{frametime:4,interpolate:true}});
  const data={version:'26.3',blocks:Array.from({length:32},(_,x)=>({name:'minecraft:stone',position:{x,y:0,z:0}}))};
  const prepared=await f.manager.prepare(data,{assetsJar:f.base});assert.equal(Object.keys(prepared.modelAssignments).length,32);assert.equal(new Set(Object.values(prepared.modelAssignments)).size,2);assert.equal(prepared.textures['fixture:block/animated'].animation.frames.length,2);
  const reverse=await f.manager.prepare({...data,blocks:[...data.blocks].reverse()},{assetsJar:f.base});assert.deepEqual(prepared.modelAssignments,reverse.modelAssignments);
  await put(f.pack,'assets/fixture/textures/block/animated.png',animationPng());const overridden=await f.manager.prepare(data,{assetsJar:f.base,resourcePack:f.pack});assert.equal(overridden.textures['fixture:block/animated'].animation,undefined);
});
test('26.3 fluid preview uses state height, animated vanilla sprite IDs and culls interior faces',async()=>{
  const f=await fixture('26.3');for(const texture of ['water_still','water_flow'])await put(f.base,`assets/minecraft/textures/block/${texture}.png`,animationPng());
  const data={version:'26.3',blocks:[{name:'minecraft:water',properties:{level:'0'},position:{x:0,y:0,z:0}},{name:'minecraft:water',properties:{level:'7'},position:{x:1,y:0,z:0}}]};
  const prepared=await f.manager.prepare(data,{assetsJar:f.base}),source=prepared.models[prepared.modelAssignments['0,0,0']],flowing=prepared.models[prepared.modelAssignments['1,0,0']];
  assert.equal(Math.max(...source.flatMap(face=>face.positions.filter((_,i)=>i%3===1))),8/9);assert.equal(Math.max(...flowing.flatMap(face=>face.positions.filter((_,i)=>i%3===1))),1/9);
  assert.equal(source.length,6);assert.equal(flowing.length,5);assert.ok(prepared.textures['minecraft:block/water_still']);assert.equal(prepared.fidelity.exactGamePixels,false);
});

