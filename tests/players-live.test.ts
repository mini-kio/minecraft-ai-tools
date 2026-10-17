import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PlayerService } from '../src/players/index.js';
import { ServerService } from '../src/servers/index.js';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
test('exact 1.21.4 Vanilla offline server: connect, native protocol controls, GUI, command, fresh viewer capture', { skip: !process.env.MCT_TEST_LIVE, timeout: 240000 }, async () => {
  const root = resolve('work', 'player-live'); await mkdir(root, { recursive: true });
  const options = { stateDir: root, artifactDir: join(root, 'artifacts') };
  const servers = new ServerService(options); const players = new PlayerService(options);
  const evidence: any = { version: '1.21.4', observedAt: new Date().toISOString(), checks: {} };
  try {
    const created = await servers.call('create', { version: '1.21.4', acceptEula: true, port: 25574 });
    const session = created.sessionId; evidence.server = created;
    const path = join(created.directory, 'server.properties');
    await writeFile(path, `${await readFile(path, 'utf8')}level-type=minecraft:flat\ngenerate-structures=false\n`);
    await servers.call('start', { session, javaPath: process.env.MCT_TEST_JAVA, memoryMb: 1024 });
    const deadline = Date.now() + 120000;
    for (;;) {
      const status = await servers.call('observe', { session });
      if (status.state === 'running') break;
      if (status.state === 'failed' || Date.now() > deadline) throw new Error(`Server startup failed: ${JSON.stringify(await servers.call('logs', { session }))}`);
      await sleep(1000);
    }
    evidence.checks.startup = true;
    const connected = await players.call('connect', { host: '127.0.0.1', port: 25574, version: '1.21.4', username: 'MCTObserver', timeoutMs: 30000 });
    const player = connected.sessionId; evidence.checks.connect = true;
    for (const text of ['op MCTObserver', 'fill -8 99 -8 8 99 8 stone', 'fill -8 100 -8 8 104 8 air', 'tp MCTObserver 0.5 100 0.5']) await servers.call('command', { session, text });
    await sleep(1500);
    const before = await players.call('observe', { session: player }); assert.equal(Math.floor(before.position.y), 100);
    const moved = await players.call('move', { session: player, x: 3.5, y: 100, z: 0.5, timeoutMs: 15000 });
    assert.ok(moved.position.x > before.position.x + 1); evidence.checks.walkToTarget = true;
    await players.call('look', { session: player, yaw: Math.PI / 2, pitch: -0.2 }); evidence.checks.look = true;
    await players.call('command', { session: player, text: 'say mct-smoke-confirmed' }); await sleep(300);
    const after = await players.call('observe', { session: player });
    assert.ok(after.messages.some((m: any) => m.text.includes('mct-smoke-confirmed'))); evidence.checks.playerCommandReply = true;
    const inventory = await players.call('inventory', { session: player }); assert.ok(Array.isArray(inventory.slots)); evidence.checks.inventory = true;
    await servers.call('command', { session, text: 'setblock 4 100 0 chest' }); await sleep(300);
    const opened = await players.call('interact', { session: player, position: { x: 4, y: 100, z: 0 }, operation: 'open' });
    assert.ok(opened.window?.slots?.length > 27); evidence.checks.chestGuiSlots = true;
    await players.call('inventory', { session: player, operation: 'close' });
    const capture = await players.call('capture', { session: player, width: 640, height: 360, timeoutMs: 45000 });
    assert.equal(capture.source, 'prismarine-viewer'); evidence.checks.capture = true; evidence.capture = capture;
    const moving = players.call('move', { session: player, controls: ['forward'], durationMs: 3000 });
    const caught = moving.catch((e: any) => e.code); await sleep(100); await players.call('stop', { session: player });
    assert.equal(await caught, 'CANCELLED'); evidence.checks.cancelReleasesInputs = true;
    evidence.player = await players.call('observe', { session: player });
  } finally {
    await players.close(); await servers.close();
    evidence.finishedAt = new Date().toISOString(); await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  }
});
