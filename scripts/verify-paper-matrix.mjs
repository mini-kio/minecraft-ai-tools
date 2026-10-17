import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { ServerService } from '../dist/servers/index.js';
import { PlayerService } from '../dist/players/index.js';
import { verifyNativePaper } from './verify-paper-native.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url), argv = process.argv.slice(2);
const option = (name, fallback) => { const i = argv.indexOf(name); return i < 0 ? fallback : argv[i + 1]; };
if (!argv.includes('--accept-eula')) throw new Error('Explicit --accept-eula is required for isolated gameplay QA');
const mode = option('--backend', 'bot'); if (!['bot', 'fabric', 'auto'].includes(mode)) throw new Error('backend must be bot, fabric or auto');
const output = path.resolve(option('--output', path.join(root, 'work/paper-qa'))); await fs.mkdir(output, { recursive: true });
const runtimes = JSON.parse(await fs.readFile(path.join(root, 'work/paper-qa/runtimes/runtimes.json'), 'utf8'));
const advertised = require('mineflayer').testedVersions;
const report = { generatedAt: new Date().toISOString(), software: 'paper', lowerBound: '1.20', source: 'https://fill.papermc.io/v3/projects/paper', mode, versions: [] };
const log = (event, fields = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const distance = (a, b) => Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z);
const scenarios = () => Object.fromEntries(['connect', 'observe', 'move', 'command', 'interact', 'capture', 'cancel'].map(k => [k, 'not-run']));
async function until(callback, timeout, label) { const deadline = Date.now()+timeout; while (Date.now()<deadline) { const v = await callback(); if (v) return v; await sleep(200); } throw new Error('Timed out: '+label); }
async function save() { await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2)); }
const manifestService = new ServerService({ stateDir: path.join(output, 'manifest'), artifactDir: output });
const targets = (await manifestService.call('versions')).versions.map(v => v.version); await manifestService.close();
const requested = option('--versions')?.split(',') ?? targets;
for (const version of requested) {
  const directory = path.join(output, version); await fs.mkdir(directory, { recursive: true });
  const result = { version, software: 'paper', startedAt: new Date().toISOString(), status: 'available-unverified', runtimeVerified: false, scenarios: scenarios(), errors: [] }; report.versions.push(result);
  let servers, players, sid, player, current;
  log('version-start', { version });
  try {
    assert(targets.includes(version), 'Version is not an official target release');
    const buildsUrl = `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`;
    const response = await fetch(buildsUrl, { headers: { 'User-Agent': process.env.MCT_DOWNLOAD_USER_AGENT || 'minecraft-ai-tools/0.1.0 (local compatibility verification; https://docs.papermc.io/misc/downloads-service/)' }, signal: AbortSignal.timeout(30000) });
    result.availability={buildsUrl,httpStatus:response.status,checkedAt:new Date().toISOString()};
    if (response.status === 404) { result.status = 'unavailable'; result.reason = 'Official Paper API has no builds for this exact release'; continue; }
    assert(response.ok, `Paper API HTTP ${response.status}`);
    const raw = await response.json(); const builds=Array.isArray(raw)?raw:raw.builds;result.availability.channelCounts=(builds??[]).reduce((counts,b)=>({...counts,[b.channel]:(counts[b.channel]??0)+1}),{});const build = builds?.filter(b => b.channel === 'STABLE').sort((a,b)=>b.id-a.id)[0];
    const download = build?.downloads?.['server:default'];
    if (!download?.checksums?.sha256) { result.status = 'unavailable'; result.reason = 'No official STABLE build with SHA256 for this exact release'; continue; }
    result.paper = { buildsUrl, build: build.id, channel: build.channel, url: download.url, sha256: download.checksums.sha256, observedAt: new Date().toISOString() };
    const backend = advertised.includes(version) ? 'mineflayer' : 'fabric'; result.backend = backend;
    if (argv.includes('--resume')) {
      const old = await fs.readFile(path.join(directory, 'result.json'), 'utf8').then(JSON.parse).catch(() => undefined);
      if (old?.runtimeVerified && old.paper?.sha256 === result.paper.sha256 && old.backend === backend) {
        if (backend === 'mineflayer') { Object.assign(result, old, { reusedAt: new Date().toISOString() }); continue; }
        const hash=createHash('sha256').update(await fs.readFile(path.join(root,'bridges/fabric/dist',`mct-bridge-${version}.jar`))).digest('hex');
        if(old.artifactSha256===hash){Object.assign(result,old,{reusedAt:new Date().toISOString()});continue;}
      }
    }
    if ((mode === 'bot' && backend !== 'mineflayer') || (mode === 'fabric' && backend !== 'fabric')) { result.reason = 'Selected verification pass targets a different backend'; continue; }
    servers = new ServerService({ stateDir: path.join(directory, 'state'), artifactDir: directory });
    players = new PlayerService({ stateDir: path.join(directory, 'player-state'), artifactDir: directory });
    let created;
    for (const candidate of (await servers.call('list')).sessions) if (candidate.version === version && candidate.software === 'paper') {
      const p = await fs.readFile(path.join(candidate.directory, 'provenance.json'), 'utf8').then(JSON.parse).catch(()=>undefined);
      if (p?.checksum === result.paper.sha256) { created = candidate; break; }
    }
    created ||= await servers.call('create', { version, software: 'paper', acceptEula: true }); sid = created.sessionId;
    const provenance = JSON.parse(await fs.readFile(path.join(created.directory, 'provenance.json'), 'utf8')); assert(provenance.checksum === result.paper.sha256, 'Stable build changed during provisioning; rerun');
    const propsPath = path.join(created.directory, 'server.properties'); let properties = await fs.readFile(propsPath,'utf8');
    properties += '\nlevel-type=minecraft:flat\ngenerate-structures=false\ndifficulty=peaceful\n'; await fs.writeFile(propsPath, properties);
    const java = runtimes[created.javaMajor || (version.startsWith('26.') ? 25 : 21)]?.java; assert(java, 'Required Java runtime was not prepared');
    result.server = { session: sid, version, java, directory: created.directory, port: created.port, checksum: provenance.checksum };
    await servers.call('start', { session: sid, javaPath: java, memoryMb: 1024, wait: true, timeoutMs: 180000 });
    const lines = (await servers.call('logs', { session: sid, lines: 500 })).lines;
    result.serverVersionLines = lines.filter(l => /Minecraft server version|running Paper|Paper version/i.test(l.line || l));
    assert(result.serverVersionLines.some(l=>new RegExp('(?:version |MC: )'+version.replaceAll('.','\\.')+'(?![\\d.])').test(l.line||l)),'Actual server log does not confirm exact requested game version');
    const admin = text => servers.call('command', { session: sid, text });
    if(backend==='fabric'){
      await verifyNativePaper({root,directory,version,java:runtimes[25].java,port:created.port,admin,result,onScenario:name=>{current=name;}});
      result.runtimeVerified=Object.values(result.scenarios).every(v=>v==='pass');result.status=result.runtimeVerified?'passed':'failed';continue;
    }
    current = 'connect'; const connected = await players.call('connect', { version, host: '127.0.0.1', port: created.port, username: 'MCTPaperQA', timeoutMs: 30000 }); player = connected.sessionId; result.scenarios.connect = 'pass';
    await admin('forceload add -8 -8 8 8'); await sleep(500);
    for (const text of ['op MCTPaperQA', 'fill -8 99 -8 8 99 8 stone', 'fill -8 100 -8 8 105 8 air', 'tp MCTPaperQA 0.5 100 0.5', 'time set noon', 'weather clear']) await admin(text);
    current = 'observe'; const initial = await until(async()=>{ const o = await players.call('observe',{session:player}); return o.position && distance(o.position,{x:.5,y:100,z:.5})<.15?o:false; },15000,'arena');
    const inventory = await players.call('inventory',{session:player}); assert(inventory.slots.length>=36,'Inventory slots missing'); result.scenarios.observe='pass'; await fs.writeFile(path.join(directory,'observation.json'),JSON.stringify(initial,null,2));
    current='move'; const moved = await players.call('move',{session:player,x:3.5,y:100,z:.5,timeoutMs:15000}); assert(distance(initial.position,moved.position)>1,'No actual movement'); result.movement={before:initial.position,after:moved.position}; result.scenarios.move='pass';
    current='command'; await players.call('command',{session:player,text:'tp @s 2.5 100 0.5'}); await until(async()=>distance((await players.call('observe',{session:player})).position,{x:2.5,y:100,z:.5})<.15,10000,'player command'); result.scenarios.command='pass';
    current='interact'; await admin('setblock 3 100 0 chest'); await sleep(300); const chest=await players.call('interact',{session:player,position:{x:3,y:100,z:0},operation:'open'}); assert(chest.window?.slots.length>36,'Chest GUI missing'); await fs.writeFile(path.join(directory,'chest.json'),JSON.stringify(chest,null,2)); await players.call('inventory',{session:player,operation:'close'}); result.scenarios.interact='pass';
    current='capture'; await players.call('look',{session:player,yaw:Math.PI/2,pitch:-.2}); const capture=await players.call('capture',{session:player,width:640,height:360,timeoutMs:45000}); assert((await fs.stat(capture.imagePath)).size>1000,'Capture missing'); result.capture=capture; result.nativeRendererVerified=false; result.scenarios.capture='pass';
    current='cancel'; const before=await players.call('observe',{session:player}); const movement=players.call('move',{session:player,controls:['forward'],durationMs:5000}).catch(e=>e.code); await sleep(250); const held=await players.call('observe',{session:player}); assert(distance(before.position,held.position)>.1,'No initial motion for cancellation'); await players.call('stop',{session:player}); assert(await movement==='CANCELLED','Movement did not cancel'); await sleep(400); const stopped=await players.call('observe',{session:player}); await sleep(600); const after=await players.call('observe',{session:player}); assert(distance(stopped.position,after.position)<.12,'Motion continued after stop'); result.cancel={before:before.position,held:held.position,stopped:stopped.position,after:after.position}; result.scenarios.cancel='pass';
    result.runtimeVerified=Object.values(result.scenarios).every(v=>v==='pass'); result.status=result.runtimeVerified?'passed':'failed';
  } catch(error) { result.status='failed'; if(current)result.scenarios[current]='failed'; result.errors.push({scenario:current,message:error.message,code:error.code,stack:error.stack}); log('version-error',{version,scenario:current,message:error.message}); }
  finally { await players?.close().catch(e=>result.errors.push({cleanup:e.message})); await servers?.close().catch(e=>result.errors.push({cleanup:e.message})); result.finishedAt=new Date().toISOString(); await fs.writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2)); await save(); log('version-finished',{version,status:result.status,scenarios:result.scenarios}); }
}
report.finishedAt=new Date().toISOString(); await save(); log('matrix-complete',{versions:report.versions.length,passed:report.versions.filter(v=>v.runtimeVerified).length,unavailable:report.versions.filter(v=>v.status==='unavailable').length});
if(report.versions.some(v=>v.status==='failed'))process.exitCode=1;
