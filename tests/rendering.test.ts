import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { ResourceManager } from '../src/resources.js';
import { viewerHtml, vendor } from '../src/viewer.js';
const require=createRequire(import.meta.url),{PNG}=require('pngjs');
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

test('26.3 browser renders frame durations/interpolation, weighted models and environment/proxy metadata', {skip:!process.env.MCT_TEST_BROWSER,timeout:60000},async()=>{
  const directory=process.env.MCT_RENDER_EVIDENCE_DIR?path.resolve(process.env.MCT_RENDER_EVIDENCE_DIR):await fs.mkdtemp(path.join(tmpdir(),'mct-render-26.3-'));
  await fs.mkdir(directory,{recursive:true});const pack=path.join(directory,'pack');
  async function put(name:string,value:any){const file=path.join(pack,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,Buffer.isBuffer(value)?value:JSON.stringify(value));}
  const image=new PNG({width:2,height:4});for(let i=0;i<8;i++){image.data[i*4]=i<4?255:0;image.data[i*4+2]=i<4?0:255;image.data[i*4+3]=255;}
  await put('assets/fixture/textures/block/animation.png',PNG.sync.write(image));
  await put('assets/fixture/textures/block/animation.png.mcmeta',{animation:{frametime:4,frames:[0,{index:1,time:8}],interpolate:true}});
  const model={textures:{all:'fixture:block/animation'},elements:[{from:[0,0,0],to:[16,16,16],faces:Object.fromEntries(['up','down','north','south','east','west'].map(side=>[side,{texture:'#all'}]))}]};
  await put('assets/fixture/models/block/a.json',model);await put('assets/fixture/models/block/b.json',model);
  await put('assets/minecraft/blockstates/stone.json',{variants:{'':[{model:'fixture:block/a',weight:1},{model:'fixture:block/b',weight:3}]}});
  const jar=path.resolve('work/fabric-tools/minecraft-26.3.jar');
  const data:any={version:'26.3',dimension:'minecraft:overworld',camera:{position:{x:.5,y:.5,z:4},target:{x:.5,y:.5,z:.5}},blocks:[{name:'minecraft:stone',properties:{},position:{x:0,y:0,z:0},environment:{biome:'minecraft:snowy_plains',known:true,light:{sky:15,block:0}}}],entities:[{id:'minecraft:armor_stand',position:{x:2,y:0,z:0},rotation:[45,0],nbt:{Invisible:0}}],blockEntities:[{id:'minecraft:chest',position:{x:3,y:0,z:0},nbt:{Items:[]}}]};
  data.resourcePreview=await new ResourceManager(path.join(directory,'state')).prepare(data,{assetsJar:jar,resourcePack:pack});
  const server=createServer((req,res)=>{void(async()=>{if(req.url?.startsWith('/viewer-data')){res.setHeader('content-type','application/json');res.end(JSON.stringify(data));}else if(req.url?.startsWith('/vendor/')){res.setHeader('content-type','text/javascript');res.end(await vendor(path.basename(req.url)));}else{res.setHeader('content-type','text/html');res.end(viewerHtml);}})().catch(error=>{res.statusCode=500;res.end(error.message);});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const {chromium}=await import('playwright');const browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const evidence:any={version:'26.3',source:'three-resource-preview',exactGamePixels:false,sourceClientSha256:hash(await fs.readFile(jar)),startedAt:new Date().toISOString(),frames:[]};
  try{
    const page=await browser.newPage({viewport:{width:640,height:480}}),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address()as any).port}/viewer?session=fixture&key=fixture`);await page.waitForFunction(()=>(window as any).__mctReady);
    await page.evaluate(()=>{document.querySelector<HTMLElement>('#info')!.style.display='none';document.querySelector<HTMLElement>('#pick')!.style.display='none';});
    for(const time of [0,100,200,550,600]){
      await page.evaluate(time=>(window as any).__mctSetAnimationTime(time),time);await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
      const bytes=await page.screenshot(),png=PNG.sync.read(bytes),offset=((png.height/2|0)*png.width+(png.width/2|0))*4,pixel=[...png.data.subarray(offset,offset+4)];
      await fs.writeFile(path.join(directory,`frame-${time}.png`),bytes);evidence.frames.push({timeMs:time,pixel,sha256:hash(bytes),metadata:await page.evaluate(()=>(window as any).__mctData)});
    }
    assert.deepEqual(errors,[]);assert.deepEqual(evidence.frames[0].metadata.textureErrors,[]);
    const red=evidence.frames[0].pixel,purple=evidence.frames[1].pixel,blue=evidence.frames[2].pixel;
    assert.ok(red[0]>red[2]+80,`initial sprite was not red: ${red}`);assert.ok(blue[2]>blue[0]+80,`second sprite was not blue: ${blue}`);assert.ok(purple[0]>60&&purple[2]>60,`interpolated sprite missing mixed channels: ${purple}`);
    assert.equal(evidence.frames[3].metadata.animationFrames[0].index,1);assert.equal(evidence.frames[4].metadata.animationFrames[0].index,0);
    const meta=evidence.frames[0].metadata;assert.equal(meta.entityCount,1);assert.equal(meta.blockEntityCount,1);assert.equal(meta.fidelity.lightInputs.known,1);assert.equal(meta.fidelity.exactGamePixels,false);
    evidence.status='passed';
  }catch(error:any){evidence.status='failed';evidence.error={message:error.message,stack:error.stack};throw error;}
  finally{await browser.close();await new Promise<void>(r=>server.close(()=>r()));evidence.finishedAt=new Date().toISOString();await fs.writeFile(path.join(directory,'evidence.json'),JSON.stringify(evidence,null,2));}
});
