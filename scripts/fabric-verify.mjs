#!/usr/bin/env node
/** Real-client acceptance driver. Requires an already running isolated client + operator-enabled local server. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const argv = process.argv.slice(2);
const opt = (key, fallback) => { const i = argv.indexOf(key); return i < 0 ? fallback : argv[i + 1]; };
const discoveryPath = opt('--discovery'); if (!discoveryPath) throw new Error('--discovery <fabric-PID.json> required');
const discovery = JSON.parse(await fs.readFile(discoveryPath, 'utf8'));
const legacy=discovery.gameVersion.startsWith('1.');
const output = path.resolve(opt('--output', path.join(path.dirname(discoveryPath), '..', 'acceptance')));
await fs.mkdir(output, { recursive: true });
const host = 'http://127.0.0.1:' + discovery.port;
const headers = { Authorization: 'Bearer ' + discovery.token, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { version: discovery.gameVersion, startedAt: new Date().toISOString(), runtimeVerified: false, scenarios: {}, images: [], observations: [] };
try { report.artifactSha256 = crypto.createHash('sha256').update(await fs.readFile(path.join(path.dirname(discoveryPath), '..', 'mods', 'mct-bridge.jar'))).digest('hex'); } catch {}
async function call(action, args = {}) {
  const response = await fetch(host + '/call', { method: 'POST', headers, body: JSON.stringify({ action, args }), signal: AbortSignal.timeout(16000) });
  const value = await response.json(); if (!response.ok || value.error) throw new Error(action + ': ' + JSON.stringify(value)); return value;
}
async function waitFor(predicate, timeout = 60000) {
  const start = Date.now(); let last;
  while (Date.now() - start < timeout) { last = await call('observe'); if (await predicate(last)) return last; await sleep(250); }
  throw new Error('State wait timed out: ' + JSON.stringify(last));
}
async function capture(name) {
  const result = await call('capture'); const bytes = Buffer.from(result.base64, 'base64');
  assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))); assert.equal(result.source, 'fabric-game-framebuffer');
  const filename = path.join(output, name + '.png'); await fs.writeFile(filename, bytes); delete result.base64;
  report.images.push({ name, file: filename, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), ...result }); return result;
}
async function scenario(name, fn) { await fn(); report.scenarios[name] = 'passed'; console.log(`${discovery.gameVersion}: ${name} passed`); }
try {
  await scenario('authentication', async () => { assert.equal((await fetch(host + '/status')).status, 401); });
  await waitFor(value => value.ready && !value.loading);
  await scenario('connect', async () => { const before = await call('observe'); if (!before.connected) await call('connect', { host: '127.0.0.1', port: Number(opt('--port', '25573')) }); const value = await waitFor(async value => { if (value.screen&&(value.screen.class.endsWith('PauseScreen')||value.screen.title==='Game Menu')) await call('input',{key:'escape'}); return value.connected && !value.loading && !value.screen; }); assert.equal(value.player.name, 'MctSmoke'); report.observations.push(value); });
  // Commands queued before a chunk arrives are rejected by Vanilla. Set up the
  // local fixture only after terrain loading has finished, then verify its data.
  await call('command',{text:'forceload add 160 316 180 336'});await sleep(500);
  await call('command',{text:'tp @s 169.5 91 326.5'});await sleep(1000);
  for(const text of ['fill 160 90 316 180 90 336 stone','fill 160 91 316 180 97 336 air','setblock 172 91 326 chest[facing=west]','tp @s 169.5 91 326.5'])await call('command',{text});
  await waitFor(value=>Math.abs(value.player.y-91)<0.1);await sleep(250);
  await scenario('observe', async () => { const a = await call('observe'); await sleep(200); const b = await call('observe'); assert(b.tick > a.tick && b.frame > a.frame); assert.equal(b.dimension, 'minecraft:overworld'); });
  await scenario('command', async () => { assert.equal((await call('command', { text: 'say MCT native acceptance ' + discovery.gameVersion })).sent, true); });
  await scenario('hotbar',async()=>{const before=await call('observe');await call('hotbar',{slot:7});const selected=await waitFor(v=>v.player.selectedSlot===7&&v.inventory.selectedSlot===7);assert.equal(selected.player.selectedSlot,7);await call('hotbar',{slot:0});await waitFor(v=>v.player.selectedSlot===0);report.hotbarEvidence={before:before.player.selectedSlot,selected:7,restored:0};});
  await scenario('move', async () => { await call('command', { text: 'tp @s 169.5 91 326.5' }); await sleep(300); await call('look', { yaw: 90, pitch: 0 }); const before = await call('observe'); await call('input', { key: 'forward', durationMs: 450 }); await sleep(700); const after = await call('observe'); assert(Math.hypot(after.player.x - before.player.x, after.player.z - before.player.z) > 0.05); report.observations.push(after); });
  await scenario('cancel', async () => { await call('input', { key: 'forward', durationMs: 3000 }); await sleep(100); await call('stop'); await sleep(500); const a = await call('observe'); await sleep(500); const b = await call('observe'); assert(Math.hypot(b.player.x - a.player.x, b.player.z - a.player.z) < 0.15); });
  await scenario('capture', async () => { await capture('native-hud'); });
  await scenario('interact', async () => {
    await call('command', { text: 'tp @s 169.5 91 326.5' }); await sleep(250); await call('look', { yaw: -90, pitch: 20 }); await sleep(100); await call('input', { key: 'use', durationMs: 150 });
    const value = await waitFor(v => v.inventory?.syncId > 0); assert(value.screen);
    await call('command',{text:'item replace block 172 91 326 container.0 with minecraft:diamond 3'});
    await waitFor(v=>v.inventory?.slots?.[0]?.count===3);
    const clicked=await call('gui',{type:'click',x:value.screen.width/2-72,y:value.screen.height/2-57,button:0});
    assert.equal(clicked.handled,true); await waitFor(v=>v.inventory?.slots?.[0]?.empty===true);
    // Put the carried stack back using the explicit container API and verify both
    // native GUI clicking and inventory commands changed actual synchronized slots.
    await call('inventory', { slot: 0, button: 0, mode: 'PICKUP' }); await waitFor(v=>v.inventory?.slots?.[0]?.count===3);
    const right=await call('gui',{type:'click',x:value.screen.width/2-72,y:value.screen.height/2-57,button:1});assert.equal(right.handled,true);await waitFor(v=>v.inventory?.slots?.[0]?.count===1);
    await call('inventory',{slot:0,button:0,mode:'PICKUP'});await waitFor(v=>v.inventory?.slots?.[0]?.count===3);
    await capture('native-chest'); report.guiClickEvidence={slot:0,beforeCount:3,afterGuiLeftClickCount:0,afterInventoryClickCount:3,afterGuiRightClickCount:1,restoredCount:3};
    assert.equal((await call('inventory')).syncId, value.inventory.syncId); await call('input', { key: 'escape' });
  });
  await scenario('gui-unicode', async () => {
    await call('input', { key: 'chat', durationMs: 150 }); await waitFor(v => v.screen&&(legacy||v.screen.class.includes('ChatScreen')));
    const value = await call('gui', { type: 'text', text: 'MCT 한글 테스트' }); assert.equal(value.accepted, value.codepoints); await capture('native-unicode-chat');
    await call('gui', { type: 'key', keyName: 'enter' }); await waitFor(v => !v.screen);
  });
  await scenario('gui-mouse-scroll', async () => {
    await call('input', { key: 'inventory' }); const value = await waitFor(v => v.screen&&(legacy||v.screen.class.includes('Inventory'))); const { width, height } = value.screen;
    assert.equal(typeof (await call('gui', { type: 'click', x: width / 2, y: height / 2, button: 0 })).handled, 'boolean');
    assert.equal(typeof (await call('gui', { type: 'scroll', x: width / 2, y: height / 2, vertical: -1 })).handled, 'boolean');
    await capture('native-inventory'); await call('input', { key: 'escape' });
  });
  await scenario('native-collision', async () => {
    const snapshot = await call('blocks', { min: { x: 168, y: 90, z: 325 }, max: { x: 173, y: 93, z: 328 } });
    assert.equal(snapshot.source, 'fabric-live-world'); assert.equal(snapshot.dimension, 'minecraft:overworld'); assert(snapshot.blocks.some(b => b.name === 'minecraft:stone' && b.shapes.length)); assert(snapshot.blocks.some(b => b.name === 'minecraft:chest' && b.shapes.length));
    const unknown = await call('blocks', { min: { x: 1000000, y: 91, z: 1000000 }, max: { x: 1000000, y: 91, z: 1000000 } }); assert.equal(unknown.blocks[0].known, false);
    await fs.writeFile(path.join(output, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
  });
  await scenario('disconnect', async () => { await call('disconnect'); await waitFor(v => !v.connected&&v.screen&&(legacy||v.screen.class.endsWith('TitleScreen'))); });
  report.runtimeVerified = true;
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1; console.error(report.error); }
report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ version: report.version, runtimeVerified: report.runtimeVerified, report: path.join(output, 'result.json'), error: report.error }));
