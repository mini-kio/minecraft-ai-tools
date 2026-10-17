import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {PNG} from 'pngjs';
const run=promisify(execFile),output=path.resolve('work/resource-preview-qa');await fs.mkdir(output,{recursive:true});
const cli=async(...args)=>JSON.parse((await run(process.execPath,['bin/mct.mjs',...args,'--state-dir',output,'--compact'],{windowsHide:true,timeout:180000})).stdout);
const evidence={startedAt:new Date().toISOString(),checks:{}};
try{
 await run(process.execPath,['examples/create-demo.mjs','work/demo'],{windowsHide:true});const source=path.resolve('work/demo/two-floor-house.schem'),hash=async()=>crypto.createHash('sha256').update(await fs.readFile(source)).digest('hex'),before=await hash();
 const opened=await cli('map','open',source);assert(opened.ok);const id=opened.result.session;
 const vanilla=await cli('map','capture',id,'--cut-y','2');assert(vanilla.ok);assert.equal(vanilla.result.source,'java-resource-model-preview');assert(vanilla.result.texturedStates>0);assert.deepEqual(vanilla.result.textureErrors,[]);
 const pack=path.join(output,'pack'),texturePath=path.join(pack,'assets/minecraft/textures/block/stone_bricks.png');await fs.mkdir(path.dirname(texturePath),{recursive:true});
 const image=new PNG({width:16,height:16});for(let y=0;y<16;y++)for(let x=0;x<16;x++)image.data.set((x+y)%4<2?[190,20,220,255]:[25,220,180,255],(y*16+x)*4);await fs.writeFile(texturePath,PNG.sync.write(image));
 const zip=path.join(output,'pack.zip');await run('python',['-c','import pathlib,zipfile,sys; r=pathlib.Path(sys.argv[1]); z=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED); [z.write(p,p.relative_to(r)) for p in r.rglob("*") if p.is_file()]; z.close()',pack,zip],{windowsHide:true});
 const configured=await cli('map','resources',id,'--resource-pack',zip);assert(configured.ok);
 const custom=await cli('map','capture',id,'--cut-y','2');assert(custom.ok);assert.deepEqual(custom.result.textureErrors,[]);assert(custom.result.resourcePacks.includes(zip));
 const a=PNG.sync.read(await fs.readFile(vanilla.result.imagePath)),b=PNG.sync.read(await fs.readFile(custom.result.imagePath));let changes=0;for(let y=300;y<a.height;y++)for(let x=300;x<a.width;x++){const i=(y*a.width+x)*4;if(a.data[i]!==b.data[i]||a.data[i+1]!==b.data[i+1]||a.data[i+2]!==b.data[i+2])changes++;}assert(changes>20000,'Resource pack must alter rendered world pixels');assert.equal(await hash(),before);
 evidence.checks.vanillaModelsAndTextures=true;evidence.checks.zipResourcePackChangesWorldPixels=changes;evidence.checks.originalMapUnchanged=true;evidence.vanilla=vanilla.result;evidence.custom=custom.result;evidence.passed=true;
 console.log(JSON.stringify({passed:true,checks:evidence.checks,vanilla:vanilla.result.imagePath,custom:custom.result.imagePath}));
}catch(error){evidence.passed=false;evidence.error=String(error.stack||error);console.error(evidence.error);process.exitCode=1;}
finally{await cli('daemon','stop');evidence.finishedAt=new Date().toISOString();await fs.writeFile(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));}
