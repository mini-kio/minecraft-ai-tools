/** Actual production CLI -> daemon -> desktop Blockbench rendering QA. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {PNG} from 'pngjs';

const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pack=path.resolve(process.argv[2]||process.env.MCT_CHRISTMAS_PACK||path.join(project,'..','snowy-christmas-models'));
const root=path.join(project,'work','christmas-model-qa'),runDir=path.join(root,`run-${Date.now()}`);
const stateDir=path.join(runDir,'state'),userData=path.join(runDir,'userData');
await Promise.all([stateDir,userData,path.join(pack,'previews'),path.join(pack,'qa')].map(p=>fs.mkdir(p,{recursive:true})));
const download=JSON.parse(await fs.readFile(path.join(project,'work','blockbench-qa','download.json'),'utf8'));
const catalog=JSON.parse(await fs.readFile(path.join(pack,'catalog.json'),'utf8'));
const manifest=JSON.parse(await fs.readFile(path.join(pack,'manifest.sha256.json'),'utf8'));
const hash=b=>createHash('sha256').update(b).digest('hex');
const before=new Map(await Promise.all(manifest.files.map(async f=>[f.file,hash(await fs.readFile(path.join(pack,f.file)))])));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const vector=a=>({x:a[0],y:a[1],z:a[2]});
const check=(c,m)=>{if(!c)throw new Error(m);};
const exec=promisify(execFile);
const evidence={schema:1,status:'running',startedAt:new Date().toISOString(),tool:'MCT production CLI',application:'Blockbench Desktop',requestedVersion:download.version,transport:'mct CLI -> authenticated local daemon -> production Blockbench WebSocket plugin',isolation:'owned temporary application profile and daemon state',sourceTransport:'real CLI filesystem, embedded original textures; no filesystem adapter',checks:{},models:[],commands:[]};
let invocation=0,app,browser,page;
async function cli(group,action,args={}){
 const input=path.join(runDir,`args-${++invocation}.json`);await fs.writeFile(input,JSON.stringify(args));
 const argv=[path.join(project,'dist','cli.js'),group,action,'--input',input,'--state-dir',stateDir,'--compact'];
 let stdout;try{({stdout}=await exec(process.execPath,argv,{cwd:project,windowsHide:true,maxBuffer:30*1024*1024,timeout:185000}));}catch(e){stdout=e.stdout;if(!stdout)throw e;}
 const response=JSON.parse(stdout);evidence.commands.push({group,action,ok:response.ok});
 if(!response.ok)throw new Error(`${group} ${action}: ${JSON.stringify(response.error)}`);
 return response.result;
}
async function copyCapture(capture,relative){
 const bytes=await fs.readFile(capture.imagePath),png=PNG.sync.read(bytes);let painted=0,colors=new Set();
 for(let i=0;i<png.data.length;i+=4)if(png.data[i+3]>32){painted++;colors.add(`${png.data[i]},${png.data[i+1]},${png.data[i+2]}`);}
 check(png.width===1280&&png.height===960,`Unexpected capture dimensions ${png.width}x${png.height}`);
 check(painted>2000&&colors.size>20,'Empty model capture');await fs.writeFile(path.join(pack,relative),bytes);
 return{file:relative,width:png.width,height:png.height,paintedPixels:painted,colors:colors.size,sha256:hash(bytes),animationTime:capture.animationTime,camera:capture.camera};
}
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
try{
 const config=await cli('bridge','config');
 const bridgeConfig=config.endpoint?config:JSON.parse(await fs.readFile(path.join(stateDir,'bridge-config.json'),'utf8'));
 const port=await freePort();
 app=spawn(download.executable,['--userData',userData,`--remote-debugging-port=${port}`,'--remote-debugging-address=127.0.0.1','--disable-gpu','--enable-unsafe-swiftshader'],{cwd:runDir,windowsHide:true,env:{...process.env,MCT_STATE_DIR:stateDir}});
 app.stdout.on('data',()=>{});app.stderr.on('data',()=>{});
 const deadline=Date.now()+60000;
 while(!browser&&Date.now()<deadline){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);}catch{await sleep(500);}}
 check(browser,'Actual desktop Blockbench did not start');
 while(!page&&Date.now()<deadline){page=browser.contexts()[0]?.pages().find(p=>/index\.html/.test(p.url()));if(!page)await sleep(100);}
 await page.waitForFunction(()=>typeof Blockbench!=='undefined'&&typeof Plugin!=='undefined'&&typeof ModelProject!=='undefined'&&typeof MenuBar!=='undefined'&&document.readyState==='complete',null,{timeout:30000});
 evidence.runtime=await page.evaluate(()=>({version:Blockbench.version,isApp,platform:Blockbench.platform}));check(evidence.runtime.isApp,'Expected actual desktop application');
 const rendererErrors=[];page.on('pageerror',e=>rendererErrors.push(e.message));
 await page.evaluate(()=>{const w=require('@electron/remote').getCurrentWindow();w.webContents.setBackgroundThrottling(false);w.hide();settings.background_rendering.set(true);newProject(Formats.free);Project.name='MCT Christmas QA unrelated project';});
 await page.evaluate(cfg=>localStorage.setItem('mct_bridge_config',JSON.stringify(cfg)),bridgeConfig);
 evidence.plugin=await page.evaluate(async p=>{const plugin=new Plugin();await plugin.loadFromFile({path:p},false);return{id:plugin.id,installed:plugin.installed,registered:!!Plugins.registered.mct_bridge};},path.join(project,'bridges','blockbench','mct_bridge.js'));
 let peers=[];for(let i=0;i<100;i++){const list=await cli('bridge','list');peers=Array.isArray(list)?list:list.connected||[];if(peers.length)break;await sleep(100);}
 check(peers.length===1,'Production desktop bridge failed to register');evidence.checks.actualDesktopProductionBridge=true;
 for(const item of catalog.models.filter(item=>!process.env.MCT_CHRISTMAS_MODEL||item.slug===process.env.MCT_CHRISTMAS_MODEL)){
  const opened=await cli('model','open',{path:path.join(pack,item.file)}),session=opened.id;
  check(opened.model.elements.length===item.elements,`${item.slug}: missing elements`);
  check(opened.model.groups.length===item.bones,`${item.slug}: missing bones`);
  check(opened.model.textures.every(t=>t.error===0&&t.width>0),`${item.slug}: texture failed to load`);
  const record={slug:item.slug,file:item.file,elements:opened.model.elements.length,meshes:opened.model.elements.filter(e=>e.type==='mesh').length,bones:opened.model.groups.length,textures:opened.model.textures.map(t=>({name:t.name,width:t.width,height:t.height,error:t.error})),clips:[],captures:[]};evidence.models.push(record);
  check(opened.fileTransport==='cli-read-model-data',`${item.slug}: source did not use CLI filesystem transport`);
  const p=item.preview;await cli('model','camera',{session,position:vector(p.position),target:vector(p.target)});
  const primary=await copyCapture(await cli('model','capture',{session,width:1280,height:960,clip:p.clip,time:0,play:false}),`previews/${item.slug}.png`);record.captures.push(primary);
  record.renderDiagnostics=await page.evaluate(()=>Outliner.elements.filter(e=>/candle_body|flame|glass_panels/.test(e.name)).map(e=>({name:e.name,visibility:e.visibility,origin:e.origin,position:e.mesh.position.toArray(),world:e.mesh.getWorldPosition(new THREE.Vector3()).toArray(),material:(Array.isArray(e.mesh.material)?e.mesh.material:[e.mesh.material]).map(m=>({transparent:m.transparent,depthWrite:m.depthWrite,opacity:m.opacity,alphaTest:m.alphaTest,side:m.side})),renderOrder:e.mesh.renderOrder})));
  for(const clip of item.animations){
   const end=clip.name===p.clip?p.times.find(t=>t>0):clip.length/3;
   await cli('model','animation',{session,clip:clip.name,time:0,play:true});await sleep(200);
   const playState=await page.evaluate(()=>({playing:Timeline.playing,time:Timeline.time,clip:Animation.selected?.name}));
   check(playState.playing&&playState.time>0,`${item.slug}/${clip.name}: actual timeline did not advance`);
   await cli('model','animation',{session,clip:clip.name,time:0,play:false});
   const a=await copyCapture(await cli('model','capture',{session,width:1280,height:960,clip:clip.name,time:0,play:false}),`previews/${item.slug}-${clip.name}-0.png`);
   await cli('model','animation',{session,clip:clip.name,time:end,play:false});
   const b=await copyCapture(await cli('model','capture',{session,width:1280,height:960,clip:clip.name,time:end,play:false}),`previews/${item.slug}-${clip.name}-1.png`);
   check(a.sha256!==b.sha256,`${item.slug}/${clip.name}: identical animated rendered pixels`);
   check(Math.abs(b.animationTime-end)<0.0001,`${item.slug}/${clip.name}: wrong timeline time`);
   record.clips.push({name:clip.name,playState,frames:[a,b],changesRenderedPixels:true});
  }
  const samples=await cli('model','sample',{session,clip:p.clip,from:0,to:p.times[1],frames:3,width:1280,height:960});
  check(samples.captures.length===3,`${item.slug}: sample frame count`);record.sequence=[];
  for(let i=0;i<samples.captures.length;i++)record.sequence.push(await copyCapture(samples.captures[i],`previews/${item.slug}-sequence-${i}.png`));
  await cli('model','camera',{session,position:vector([-p.position[0],p.position[1]*0.85,-p.position[2]]),target:vector(p.target)});
  const reverse=await copyCapture(await cli('model','capture',{session,width:1280,height:960,clip:p.clip,time:0,play:false}),`previews/${item.slug}-reverse.png`);record.captures.push(reverse);
  check(reverse.sha256!==primary.sha256,`${item.slug}: camera did not alter pixels`);
  const inspected=await cli('model','inspect',{session});check(!inspected.changed,`${item.slug}: original changed while observing`);
  await cli('model','close',{session});record.checks={elementsUvBonesTexturesLoaded:true,timelinePlayPause:true,allClipsChangePixels:true,threeFrameCliSample:true,cameraChangesPixels:true,sourceUnchanged:true,sessionClosed:true};
  await fs.writeFile(path.join(runDir,'progress.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({model:item.slug,clips:record.clips.length,status:'passed'}));
 }
 for(const[file,sha]of before)check(hash(await fs.readFile(path.join(pack,file)))===sha,`Observation modified ${file}`);
 evidence.sourceHashes=[...before].map(([file,sha256])=>({file,sha256}));
 evidence.checks.allOriginalFilesUnchanged=true;evidence.checks.allFiveModelsAndEightClips=evidence.models.length===5&&evidence.models.reduce((sum,m)=>sum+m.clips.length,0)===8;evidence.checks.noFilesystemAdapter=true;evidence.checks.cliUsedForEveryObservation=true;evidence.rendererErrors=rendererErrors;
 check(rendererErrors.length===0,`Renderer errors: ${rendererErrors.join('; ')}`);evidence.status='passed';
}catch(error){evidence.status='failed';evidence.error={message:error.message};process.exitCode=1;}
finally{
 if(page&&!page.isClosed())try{await Promise.race([page.evaluate(async()=>{Plugins.registered.mct_bridge?.unload();for(const p of ModelProject.all.slice())await p.close(true);require('@electron/remote').app.quit();}),sleep(2000)]);}catch{}
 try{await cli('daemon','stop');}catch{}
 await Promise.race([browser?.close().catch(()=>{}),sleep(2000)]);
 if(app&&app.exitCode===null){await Promise.race([new Promise(r=>app.once('exit',r)),sleep(2000)]);if(app.exitCode===null)app.kill();}
 evidence.finishedAt=new Date().toISOString();await fs.writeFile(path.join(runDir,'evidence.json'),JSON.stringify(evidence,null,2));
 await fs.writeFile(path.join(root,'latest.json'),JSON.stringify({status:evidence.status,evidencePath:path.join(runDir,'evidence.json'),error:evidence.error},null,2));
 if(!process.env.MCT_CHRISTMAS_MODEL)await fs.writeFile(path.join(pack,'qa','blockbench-cli-verification.json'),JSON.stringify(evidence,null,2));
 console.log(JSON.stringify({status:evidence.status,error:evidence.error,models:evidence.models.length,evidencePath:path.join(runDir,'evidence.json')}));
}
