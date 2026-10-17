#!/usr/bin/env node
/** Sequential real-client QA. Uses only generated offline identities and loopback test servers. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (key, fallback) => { const i = argv.indexOf(key); return i === -1 ? fallback : argv[i + 1]; };
const requestedJavaHome = option('--java-home', process.env.JAVA_HOME);
if (!requestedJavaHome) throw new Error('--java-home is required');
const javaHome = path.resolve(requestedJavaHome);
const java = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
await fs.access(java);
const gameplay = argv.includes('--gameplay');
if (gameplay && !argv.includes('--accept-eula')) throw new Error('Gameplay QA creates local Vanilla servers; pass --accept-eula after reviewing https://aka.ms/MinecraftEULA');
const compatibility = JSON.parse(await fs.readFile(path.join(root, 'bridges/fabric/compatibility.json'), 'utf8'));
const versions = option('--versions')?.split(',') ?? compatibility.versions.map(v => v.version).filter(v => /^1\./.test(v));
const output = path.resolve(option('--output', path.join(root, 'work/fabric-runtime-legacy')));
await fs.mkdir(output, { recursive: true });
const stopFile=path.resolve(option('--stop-file',path.join(output,'stop.request')));let stopRequested=false;process.on('SIGINT',()=>{stopRequested=true;});
const run = promisify(execFile);
const summary = { generatedAt: new Date().toISOString(), java, mode: gameplay ? 'gameplay' : 'title-screen-only', identity: 'MctSmoke offline isolated QA', versions: [] };
const log = (event, value = {}) => process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event, ...value }) + '\n');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
async function until(callback, milliseconds, description) { const deadline = Date.now() + milliseconds; let last; while (Date.now() < deadline) { try { const value = await callback(); if (value) return value; } catch (e) { if (e.fatal) throw e; last = e; } await delay(300); } throw new Error(`Timed out: ${description}${last ? '; ' + last.message : ''}`); }
async function saveSummary() { await fs.writeFile(path.join(output, 'results.json'), JSON.stringify(summary, null, 2)); }

for (const version of versions) {
  if(stopRequested||await fs.stat(stopFile).then(()=>true,()=>false)){summary.stoppedBeforeVersion=version;break;}
  const directory = path.join(output, version); await fs.mkdir(directory, { recursive: true });
  if (argv.includes('--resume')) {
    try {
      const previous = JSON.parse(await fs.readFile(path.join(directory, 'result.json'), 'utf8'));
      const currentHash = createHash('sha256').update(await fs.readFile(path.join(root, 'bridges/fabric/dist', `mct-bridge-${version}.jar`))).digest('hex');
      if (previous.runtimeVerified && previous.hotbar?.pass && previous.guiClicks?.pass && previous.unicodeChat?.pass && Object.values(previous.runtimeScenarios).every(s => s === 'pass') && previous.artifactSha256 === currentHash) { summary.versions.push(previous); await saveSummary(); log('version-reused', { version, artifactSha256: currentHash }); continue; }
    } catch { /* Missing, partial and stale-artifact results must run again. */ }
  }
  const result = { version, startedAt: new Date().toISOString(), runtimeVerified: false, runtimeScenarios: Object.fromEntries(['connect', 'observe', 'move', 'command', 'interact', 'capture', 'cancel'].map(k => [k, 'not-run'])), evidenceDirectory: directory, errors: [] };
  summary.versions.push(result); let client; let server; let sid; let discovery; let currentScenario;
  log('version-start', { version });
  try {
    const prepared = await run(process.execPath, [path.join(root, 'scripts/fabric-smoke.mjs'), '--java-home', javaHome, '--version', version, '--prepare-only'], { cwd: root, windowsHide: true, timeout: 240000, maxBuffer: 2 * 1024 * 1024 });
    await fs.writeFile(path.join(directory, 'prepare.log'), prepared.stdout + prepared.stderr);
    const gameDir = path.join(root, 'work/fabric-tools', 'smoke-' + version);
    const launch = JSON.parse(await fs.readFile(path.join(gameDir, 'launch.json'), 'utf8'));
    result.artifactSha256 = createHash('sha256').update(await fs.readFile(path.join(gameDir, 'mods/mct-bridge.jar'))).digest('hex');
    if (gameplay) {
      const { ServerService } = await import('../dist/servers/index.js');
      server = new ServerService({ stateDir: path.join(directory, 'state'), artifactDir: directory });
      const created = await server.call('create', { version, acceptEula: true }); sid = created.sessionId;
      await fs.appendFile(path.join(created.directory, 'server.properties'), 'level-type=minecraft:flat\ngenerate-structures=false\ndifficulty=peaceful\n');
      result.server = { version, port: created.port, directory: created.directory, checksum: created.checksum };
      await server.call('start', { session: sid, javaPath: java, memoryMb: 1024 });
      await until(async () => { const state = await server.call('observe', { session: sid }); if (state.state === 'failed') throw Object.assign(new Error(state.lastError || 'Vanilla server failed'), { fatal: true }); return state.state === 'running'; }, 120000, 'Vanilla ready');
      log('server-ready', { version, port: created.port });
    }
    const consoleFile = await fs.open(path.join(directory, 'client-console.log'), 'w');
    client = spawn(java, launch.args, { cwd: gameDir, windowsHide: true, stdio: ['ignore', consoleFile.fd, consoleFile.fd] }); await consoleFile.close();
    let launchError; client.on('error', error => { launchError = error; });
    result.clientPid = client.pid;
    discovery = await until(async () => {
      if (launchError || client.exitCode !== null) throw Object.assign(launchError || new Error('Minecraft client exited with ' + client.exitCode), { fatal: true });
      const names = await fs.readdir(path.join(gameDir, '.mct')).catch(() => []);
      for (const name of names.filter(name => name.endsWith('.json'))) { const record = JSON.parse(await fs.readFile(path.join(gameDir, '.mct', name), 'utf8')); if (record.pid === client.pid) return record; }
      return false;
    }, 90000, 'bridge discovery');
    const headers = { authorization: `Bearer ${discovery.token}`, 'content-type': 'application/json' };
    async function status() { const response = await fetch(`http://127.0.0.1:${discovery.port}/status`, { headers, signal: AbortSignal.timeout(12000) }); if (!response.ok) throw new Error('status HTTP ' + response.status); return response.json(); }
    async function call(action, args = {}) { const response = await fetch(`http://127.0.0.1:${discovery.port}/call`, { method: 'POST', headers, body: JSON.stringify({ action, args }), signal: AbortSignal.timeout(15000) }); const value = await response.json(); if (!response.ok || value.error) throw new Error(`${action}: ${JSON.stringify(value.error || value)}`); return value; }
    async function capture(name) { const value = await call('capture'); assert(value.source === 'fabric-game-framebuffer' && value.base64, 'Capture did not return the native framebuffer'); const bytes = Buffer.from(value.base64, 'base64'); assert(bytes.subarray(1, 4).toString() === 'PNG', 'Invalid screenshot PNG'); await fs.writeFile(path.join(directory, name + '.png'), bytes); const { base64, ...meta } = value; await fs.writeFile(path.join(directory, name + '.json'), JSON.stringify(meta, null, 2)); return meta; }
    const readyStatus = await until(async () => { const value = await status(); return value.ready && value.frame > 0 ? value : false; }, 90000, 'client tick/render hooks');
    // The first render hook can execute while vanilla's resource reload overlay is
    // still active. Connecting then can render a world before shaders exist.
    await delay(Number(option('--warmup-ms', readyStatus.loading === false ? '1000' : '10000')));
    const title = await call('observe'); await fs.writeFile(path.join(directory, 'title-observation.json'), JSON.stringify(title, null, 2));
    await capture('title-screen'); result.titleScreenObserve = 'pass'; result.titleScreenCapture = 'pass'; log('title-ready', { version });
    if (gameplay) {
      const admin = command => server.call('command', { session: sid, command });
      currentScenario = 'connect';
      await call('connect', { host: '127.0.0.1', port: result.server.port });
      await until(async () => { const s = await status(); return s.connected && s.screen === null; }, 60000, 'local server connect and terrain screen close'); result.runtimeScenarios.connect = 'pass';
      currentScenario = 'observe';
      await admin('forceload add -8 -8 8 8'); await delay(500);
      for (const command of ['op MctSmoke', 'fill -8 99 -8 8 99 8 stone', 'fill -8 100 -8 8 105 8 air', 'gamemode creative MctSmoke', 'tp MctSmoke 0.5 100 0.5', 'time set noon', 'weather clear']) await admin(command);
      const initial = await until(async () => { const s = await status(); return s.ready && s.player && distance(s.player, { x: 0.5, y: 100, z: 0.5 }) < 0.15 ? s : false; }, 15000, 'arena teleport');
      await delay(1000); const observation = await call('observe'); assert(observation.inventory?.slots?.length >= 36 && observation.connected, 'Player inventory observation missing'); result.runtimeScenarios.observe = 'pass';
      await fs.writeFile(path.join(directory, 'world-observation.json'), JSON.stringify(observation, null, 2));
      const selected=[];for(const slot of [0,7,0]){const changed=await call('hotbar',{slot});assert(changed.selectedSlot===slot,'Hotbar acknowledgement differs from requested slot');const observed=await call('observe');assert(observed.player?.selectedSlot===slot&&observed.inventory?.selectedSlot===slot,'Hotbar player/inventory telemetry differs');selected.push({slot,result:changed,playerSlot:observed.player.selectedSlot,inventorySlot:observed.inventory.selectedSlot});}
      for(const slot of [-1,9,1.5]){let rejected=false;try{await call('hotbar',{slot});}catch{rejected=true;}assert(rejected,'Invalid hotbar slot was accepted: '+slot);}
      result.hotbar={pass:true,selections:selected,invalidRejected:[-1,9,1.5]};await fs.writeFile(path.join(directory,'hotbar-observation.json'),JSON.stringify(result.hotbar,null,2));
      currentScenario = 'move'; await call('look', { yaw: 0, pitch: 0 }); await call('input', { key: 'forward', durationMs: 500 }); await delay(850); const moved = await call('observe'); assert(Math.hypot(initial.player.x - moved.player.x, initial.player.z - moved.player.z) > 0.2 && Math.abs(moved.player.y - 100) < 0.2, 'Timed input did not move horizontally on the arena floor'); result.runtimeScenarios.move = 'pass'; result.movement = { before: initial.player, after: moved.player };
      currentScenario = 'command';
      await call('command', { text: 'tp @s 3.5 100 0.5' }); await until(async () => { const s = await status(); return s.player && distance(s.player, { x: 3.5, y: 100, z: 0.5 }) < 0.15; }, 12000, 'player command teleport'); result.runtimeScenarios.command = 'pass';
      currentScenario = 'interact'; await admin('setblock 3 101 2 chest[facing=north]'); await delay(800);
      let chest; const interactionAttempts = [];
      for (let attempt = 0; attempt < 3 && !chest; attempt++) {
        await call('stop'); await call('command', { text: 'tp @s 3.5 100 0.5' });
        await until(async () => { const s = await status(); return s.player && distance(s.player, { x: 3.5, y: 100, z: 0.5 }) < 0.1; }, 5000, 'interaction pose reset');
        await call('look', { yaw: 0, pitch: 3.5 }); await call('input', { key: 'use', durationMs: 150 });
        try { chest = await until(async () => { const s = await status(); return s.inventory?.slots?.length > 46 && s.inventory.syncId > 0 ? s : false; }, 4000, 'chest interaction'); }
        catch { const missed = await call('observe'); interactionAttempts.push({ attempt: attempt + 1, player: missed.player, screen: missed.screen }); }
      }
      result.interactionAttempts = interactionAttempts;
      assert(chest, 'Chest did not open after three reset-and-look attempts; inspect interactionAttempts for physical input interference');
      result.runtimeScenarios.interact = 'pass'; await fs.writeFile(path.join(directory, 'chest-observation.json'), JSON.stringify(chest, null, 2));
      await admin('item replace block 3 101 2 container.0 with minecraft:diamond 3');
      const slotCount=async expected=>until(async()=>{const value=await call('observe');return value.inventory?.slots?.[0]?.count===expected?value:false;},5000,'chest slot count '+expected);
      const stocked=await slotCount(3),gx=stocked.screen.width/2-72,gy=stocked.screen.height/2-57;
      const leftClick=await call('gui',{type:'click',x:gx,y:gy,button:0});await slotCount(0);await call('inventory',{slot:0,button:0,mode:'PICKUP'});await slotCount(3);
      const rightClick=await call('gui',{type:'click',x:gx,y:gy,button:1});await slotCount(1);await call('inventory',{slot:0,button:0,mode:'PICKUP'});const restored=await slotCount(3);
      result.guiClicks={pass:true,leftClick,rightClick,logicalPosition:{x:gx,y:gy},restoredCount:restored.inventory.slots[0].count};await fs.writeFile(path.join(directory,'gui-click-observation.json'),JSON.stringify(result.guiClicks,null,2));
      await capture('chest-screen'); await call('input', { key: 'escape' }); await delay(300);
      await call('input',{key:'chat'});await until(async()=>{const value=await call('observe');return value.screen?value:false;},5000,'chat input open');const text='MCT 한글 테스트',typed=await call('gui',{type:'text',text});assert(typed.accepted===Array.from(text).length,'Unicode GUI text was not fully accepted');await capture('unicode-chat-screen');await call('gui',{type:'key',keyName:'enter'});await until(async()=>{const logs=await server.call('logs',{session:sid});return logs.lines.some(line=>line.line.includes(text));},5000,'Unicode GUI chat reached Vanilla server');result.unicodeChat={pass:true,text,accepted:typed.accepted};result.additionalScenarios={hotbar:'pass',guiLeftClick:'pass',guiRightClick:'pass',guiUnicodeChat:'pass'};
      await fs.writeFile(path.join(directory,'unicode-chat-observation.json'),JSON.stringify(result.unicodeChat,null,2));
      currentScenario = 'capture'; await capture('world-screen'); result.runtimeScenarios.capture = 'pass';
      // Face away from the chest so an obstacle cannot make a broken cancellation
      // look successful. Confirm motion first, then confirm it stops in open space.
      currentScenario = 'cancel'; await call('look', { yaw: 90, pitch: 0 }); const beforeCancel = await call('observe'); await call('input', { key: 'forward', durationMs: 5000 }); await delay(200); const held = await call('observe'); assert(distance(beforeCancel.player, held.player) > 0.1, 'Cancellation fixture did not produce initial motion'); await call('stop'); await delay(300); const stopped = await call('observe'); await delay(600); const still = await call('observe'); assert(distance(stopped.player, still.player) < 0.12, 'Player continued moving after stop'); result.runtimeScenarios.cancel = 'pass';
      await fs.writeFile(path.join(directory, 'cancel-observation.json'), JSON.stringify({ before: beforeCancel, held, stopped, after: still }, null, 2)); await call('disconnect');
      result.runtimeVerified = Object.values(result.runtimeScenarios).every(s => s === 'pass')&&result.hotbar?.pass&&result.guiClicks?.pass&&result.unicodeChat?.pass;
    }
  } catch (error) { if (currentScenario && result.runtimeScenarios[currentScenario] !== 'pass') result.runtimeScenarios[currentScenario] = 'failed'; result.errors.push({ scenario: currentScenario, message: error.message, stack: error.stack }); log('version-error', { version, scenario: currentScenario, message: error.message }); }
  finally {
    if (client && client.exitCode === null) { client.kill(); await Promise.race([new Promise(r => client.once('exit', r)), delay(10000)]); }
    if (server) await server.close().catch(error => result.errors.push({ cleanup: error.message }));
    result.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2)); await saveSummary();
    log('version-finished', { version, runtimeVerified: result.runtimeVerified, runtimeScenarios: result.runtimeScenarios, errors: result.errors.map(e => e.message) });
  }
}
summary.finishedAt = new Date().toISOString(); await saveSummary(); log('complete', { output, total: summary.versions.length, runtimeVerified: summary.versions.filter(v => v.runtimeVerified).length });
if (summary.versions.some(v => v.errors.length || (gameplay && !v.runtimeVerified))) process.exitCode = 1;
