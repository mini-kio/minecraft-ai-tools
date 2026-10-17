import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { BridgeService } from '../src/bridges.js';
import { ModelService } from '../src/models.js';
import { JobManager } from '../src/jobs.js';
import { Application } from '../src/app.js';
import { once } from 'node:events';

test('Blockbench bridge correlated responses support open, reload and capture without returning image payloads', async () => {
  const stateDir = await fs.mkdtemp(path.resolve('work/core-'));
  const bridge = new BridgeService({ stateDir, artifactDir: path.join(stateDir, 'artifacts') });
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  let peer: any;
  server.on('connection', socket => { peer = bridge.register(socket, { kind: 'blockbench', name: 'fixture', capabilities: ['model.open'] }); });
  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as any).port}`); await once(client, 'open');
  let project = 'first';
  client.on('message', raw => { const req = JSON.parse(String(raw)); if (req.action === 'model.reload') project = 'second'; assert.equal(req.args.project || project, req.action === 'model.reload' ? 'first' : project); const result = req.action === 'model.capture' ? { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl9l1sAAAAASUVORK5CYII=' } : { project, name: 'fixture' }; client.send(JSON.stringify({ id: req.id, result })); });
  try {
    const fixture=path.join(stateDir,'fixture.bbmodel');await fs.writeFile(fixture,'{"meta":{"model_format":"free"}}');
    const model = new ModelService(bridge); const opened = await model.call('open', { path: fixture, bridge: peer.id });
    await model.call('reload', { session: opened.id }); const shot = await model.call('capture', { session: opened.id });
    assert.equal(shot.source, 'blockbench'); assert.equal(shot.base64, undefined); assert.ok((await fs.stat(shot.imagePath)).size > 30);
  } finally { client.close(); await bridge.close(); await new Promise<void>(r => server.close(() => r())); }
});

test('jobs only claim cancellation when a concrete cancellation handler runs', async () => {
  const jobs = new JobManager(); let stop = false; let reject!: (value: any) => void;
  const started = jobs.start(() => new Promise((_r,j) => { reject = j; }), async () => { stop = true;reject(Object.assign(new Error('stopped'),{code:'CANCELLED'})); });
  assert.equal((await jobs.call('cancel', { job: started.id })).state, 'cancelled'); assert.equal(stop, true);
  await new Promise(r => setImmediate(r)); assert.equal((await jobs.call('status', { job: started.id })).state, 'cancelled');
});

test('jobs remain cancelling until cleanup settles and preserve cleanup failures',async()=>{
  const jobs=new JobManager();let failCleanup!:(error:any)=>void;
  const started=jobs.start(()=>new Promise((_r,reject)=>{failCleanup=reject;}),async()=>{});
  assert.equal((await jobs.call('cancel',{job:started.id,waitMs:0})).state,'cancelling');
  failCleanup(Object.assign(new Error('owned child still running'),{code:'CANCELLATION_CLEANUP_FAILED'}));await new Promise(r=>setImmediate(r));
  const final=await jobs.call('status',{job:started.id});assert.equal(final.state,'failed');assert.equal(final.error.code,'CANCELLATION_CLEANUP_FAILED');
});

test('async server provisioning receives cancellation and finishes only after owned cleanup',async()=>{
  const directory=await fs.mkdtemp(path.resolve('work/provision-job-')),app=new Application({stateDir:directory,artifactDir:directory});
  let signal:AbortSignal|undefined,finishCleanup!:()=>void,begin!:()=>void;const cleanup=new Promise<void>(resolve=>{finishCleanup=resolve;}),started=new Promise<void>(resolve=>{begin=resolve;});
  app.servers.call=async(action,args)=>{if(action!=='create')return{};signal=args.signal;begin();return new Promise((_resolve,reject)=>{const abort=()=>{void cleanup.then(()=>reject(Object.assign(new Error('owned staging removed'),{code:'CANCELLED'})));};if(signal!.aborted)abort();else signal!.addEventListener('abort',abort,{once:true});});};
  try{const job=await app.execute('test','create',{version:'26.3',async:true});await started;assert(signal);const cancelling=await app.execute('job','cancel',{job:job.id,waitMs:0});assert.equal(signal.aborted,true);assert.equal(cancelling.state,'cancelling');finishCleanup();await new Promise(r=>setImmediate(r));assert.equal((await app.execute('job','status',{job:job.id})).state,'cancelled');}
  finally{finishCleanup?.();await app.close();}
});

test('daemon job shutdown awaits cleanup that was already cancelling',async()=>{
  const jobs=new JobManager();let finish!:(error:any)=>void;const job=jobs.start(()=>new Promise((_r,reject)=>{finish=reject;}),async()=>{});
  await jobs.call('cancel',{job:job.id,waitMs:0});let closed=false;const closing=jobs.close().then(()=>{closed=true;});await new Promise(r=>setImmediate(r));assert.equal(closed,false);
  finish(Object.assign(new Error('cleanup finished'),{code:'CANCELLED'}));await closing;assert.equal((await jobs.call('status',{job:job.id})).state,'cancelled');
});

test('stopping model sampling during capture prevents later animation frames',async()=>{
  let captured=0,started!:()=>void,release!:(value:any)=>void;const began=new Promise<void>(r=>{started=r;});
  const bridge={peers:new Map([['bb',{id:'bb',kind:'blockbench'}]]),request:async(_peer:string,action:string)=>{if(action==='model.open')return{project:'p'};captured++;started();return new Promise(r=>{release=r;});}};
  const directory=await fs.mkdtemp(path.resolve('work/model-sample-')),fixture=path.join(directory,'fixture.bbmodel');await fs.writeFile(fixture,'{"meta":{}}');
  const model=new ModelService(bridge as any),session=await model.call('open',{bridge:'bb',path:fixture});
  const sampling=model.call('sample',{session:session.id,clip:'walk',frames:3});await began;await model.call('stop',{session:session.id});release({imagePath:'first.png'});
  await assert.rejects(sampling,(e:any)=>e.code==='CANCELLED');assert.equal(captured,1);
});

test('an unavailable native client never produces a successful tour report', async () => {
  const stateDir = await fs.mkdtemp(path.resolve('work/core-')); const app = new Application({ stateDir, artifactDir: stateDir });
  app.maps.call = async () => ({ targets: [] });
  app.bridges.peers.set('native-fixture', { id: 'native-fixture', kind: 'fabric', name: 'fixture', capabilities: [] });
  try { await assert.rejects(app.execute('interior', 'tour', { session: 'map-fixture', player: 'native-fixture', inspection: { bounds: { min:{x:0,y:0,z:0},max:{x:3,y:3,z:3} }, entry:{x:1,y:1,z:1},floors:[],targets: [{ id: 'room', position: { x: 2, y: 1, z: 1 } }] } }), (e:any)=>e.code==='BRIDGE_DISCONNECTED'); }
  finally { await app.close(); }
});
