import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlayerService, boundedMs, requireExactVersion, withDeadline, instrumentViewerBundle } from '../src/players/index.js';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');
class FakeBot extends EventEmitter {
  username = 'Observer'; version = '1.20.1'; health = 20; food = 20;
  entity = { position: new Vec3(0.5, 1, 0.5), yaw: 0, pitch: 0 };
  entities = {}; inventory = { slots: [] }; currentWindow: any = null; world: any;
  keys = new Set<string>(); controlsCleared = 0; quitCalled = false;
  pathfinder = { setGoal: (_g: unknown) => {}, setMovements: (_g: unknown) => {}, goto: async () => new Promise<void>(() => {}), searchRadius: 0 };
  loadPlugin() {}
  clearControlStates() { this.controlsCleared++; this.keys.clear(); }
  setControlState(key: string, down: boolean) { if (down) this.keys.add(key); else this.keys.delete(key); }
  quit() { this.quitCalled = true; this.emit('end'); }
  async look(yaw: number, pitch: number) { this.entity.yaw = yaw; this.entity.pitch = pitch; }
  deactivateItem() {}
  blockAt() { return null; }
}
async function fixture(bot = new FakeBot(), extra: any = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mct-player-'));
  const service = new PlayerService({ stateDir: root, artifactDir: join(root, 'artifacts') }, {
    mineflayer: { testedVersions: ['1.20.1'], createBot: () => { setImmediate(() => bot.emit('spawn')); return bot; } },
    pathfinder: { pathfinder() {}, Movements: class {}, goals: { GoalNear: class {} } }, vec3: Vec3, ...extra,
  });
  const connected = await service.call('connect', { version: '1.20.1' });
  return { service, bot, root, session: connected.sessionId };
}

test('exact game version gate never silently selects another protocol', () => {
  assert.doesNotThrow(() => requireExactVersion('1.20.1', ['1.20.1']));
  assert.throws(() => requireExactVersion('26.3', ['1.20.1']), { code: 'CLIENT_REQUIRED' });
  assert.throws(() => requireExactVersion('1.20', ['1.20.1']), { code: 'CLIENT_REQUIRED' });
  assert.throws(() => boundedMs(-1), { code: 'INVALID_ARGUMENT' });
});
test('deadlines settle and aborted calls do not hang', async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 10), { code: 'TIMEOUT' });
  const c = new AbortController(); c.abort();
  await assert.rejects(withDeadline(new Promise(() => {}), 10000, c.signal), { code: 'CANCELLED' });
});
test('movement cancellation releases controls and leaves a reusable session', async () => {
  const { service, bot, session } = await fixture();
  const move = service.call('move', { session, controls: ['forward'], durationMs: 1000 });
  await new Promise(r => setTimeout(r, 10)); assert.equal(bot.keys.has('forward'), true);
  await service.call('stop', { session });
  await assert.rejects(move, { code: 'CANCELLED' });
  assert.equal(bot.keys.size, 0);
  const completed = await service.call('move', { session, durationMs: 5 });
  assert.equal(completed.inputsReleased, true); assert.equal(bot.keys.size, 0);
  await service.close(); assert.equal(bot.quitCalled, true);
});
test('target movement has a deadline and cannot enable block breaking or placement', async () => {
  const { service, bot, session } = await fixture(); let movements: any;
  bot.pathfinder.setMovements = v => { movements = v; };
  await assert.rejects(service.call('move', { session, x: 20, y: 1, z: 0, timeoutMs: 10 }), { code: 'TIMEOUT' });
  assert.equal(movements.canDig, false); assert.equal(movements.allow1by1towers, false);
  assert.equal(movements.canOpenDoors, false); assert.equal(movements.allowParkour, false);
  assert.deepEqual(movements.scafoldingBlocks, []); assert.equal(bot.keys.size, 0);
  await service.close();
});
test('pathfinder completion without actual arrival is not a successful visit', async () => {
  const { service, bot, session } = await fixture();
  bot.pathfinder.goto = async () => {};
  await assert.rejects(service.call('move', { session, x: 10, y: 1, z: 0.5 }), { code: 'TARGET_NOT_REACHED' });
  assert.equal(bot.keys.size, 0); await service.close();
});
test('observation includes GUI slots and provenance, rejects missing chunks', async () => {
  const { service, bot, session } = await fixture();
  bot.currentWindow = { id: 7, title: 'Chest', type: 'generic_9x3', slots: [null, { name: 'stone', count: 4, slot: 1 }] };
  const observed = await service.call('observe', { session });
  assert.equal(observed.source, 'server-protocol'); assert.equal(observed.window.slots[1].name, 'stone');
  assert.equal(observed.capabilities.nativeHud, false);
  await assert.rejects(service.call('interact', { session, x: 1, y: 2, z: 3 }), { code: 'CHUNK_UNAVAILABLE' });
  await assert.rejects(service.call('inventory', { session, operation: 'click', slot: 5 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(service.call('command', { session, text: 'say hello\nstop' }), { code: 'INVALID_ARGUMENT' });
  await service.close();
});
test('negotiation mismatch disconnects without pretending compatibility', async () => {
  const bot = new FakeBot(); bot.version = '1.21.1';
  const root = await mkdtemp(join(tmpdir(), 'mct-player-'));
  const service = new PlayerService({ stateDir: root, artifactDir: root }, { mineflayer: { testedVersions: ['1.20.1'], createBot: () => { setImmediate(() => bot.emit('spawn')); return bot; } }, pathfinder: {}, vec3: Vec3 });
  await assert.rejects(service.call('connect', { version: '1.20.1' }), { code: 'VERSION_MISMATCH' });
  assert.equal(bot.quitCalled, true); await service.close();
});
test('opt-in Microsoft device login returns a JSON challenge while keeping token cache outside artifacts', async () => {
  const bot = new FakeBot(); const root = await mkdtemp(join(tmpdir(), 'mct-player-auth-'));
  let options: any;
  const service = new PlayerService({ stateDir: root, artifactDir: join(root, 'artifacts') }, {
    mineflayer: { testedVersions: ['1.20.1'], createBot: (input: any) => { options = input; setImmediate(() => input.onMsaCode({ user_code: 'TEST-CODE', verification_uri: 'https://www.microsoft.com/link', expires_in: 900 })); return bot; } },
    pathfinder: { pathfinder() {} }, vec3: Vec3,
  });
  const pending = await service.call('connect', { version: '1.20.1', auth: 'microsoft', username: 'account@example.test' });
  assert.equal(pending.authPending, true); assert.equal(pending.authentication.userCode, 'TEST-CODE');
  assert.equal(options.profilesFolder, join(root, 'auth')); assert.equal(options.logErrors, false);
  bot.emit('spawn'); await new Promise(r => setImmediate(r));
  const ready = await service.call('observe', { session: pending.sessionId });
  assert.equal(ready.state, 'connected'); assert.equal(ready.authentication, undefined);
  await service.close();
});
test('published viewer instrumentation exposes exactly one completion hook without changing installed files', async () => {
  const path = require.resolve('prismarine-viewer');
  const { dirname } = await import('node:path');
  const bytes = await readFile(join(dirname(path), 'public', 'index.js'), 'utf8');
  const result = instrumentViewerBundle(bytes);
  assert.equal((result.match(/window\.viewer=/g) ?? []).length, 1);
  assert.equal(await readFile(join(dirname(path), 'public', 'index.js'), 'utf8'), bytes);
  assert.throws(() => instrumentViewerBundle('wrong bundle'), { code: 'VIEWER_INCOMPATIBLE' });
});
test('caller abort cancels pathfinding and timed movement and keeps the connected session reusable', async () => {
  const { service, session, bot } = await fixture();
  for (const args of [{ controls: ['forward'], durationMs: 1000 }, { x: 10, y: 1, z: 0.5 }]) {
    const controller = new AbortController(); const operation = service.call('move', { session, ...args, signal: controller.signal });
    await new Promise(r => setTimeout(r, 5)); controller.abort();
    await assert.rejects(operation, { code: 'CANCELLED' }); assert.equal(bot.keys.size, 0);
    assert.equal((await service.call('observe', { session })).state, 'connected');
  }
  await service.close();
});
test('connection abort waits for the owned connection to end and removes the incomplete session', async () => {
  const bot = new FakeBot(); let ended = false;
  bot.quit = () => { bot.quitCalled = true; setTimeout(() => { ended = true; bot.emit('end'); }, 30); };
  const root = await mkdtemp(join(tmpdir(), 'mct-player-connect-cancel-'));
  const service = new PlayerService({ stateDir: root, artifactDir: root }, { mineflayer: { testedVersions: ['1.20.1'], createBot: () => bot }, pathfinder: {} });
  const controller = new AbortController(); const operation = service.call('connect', { version: '1.20.1', signal: controller.signal });
  controller.abort(); await assert.rejects(operation, { code: 'CANCELLED' });
  assert.equal(ended, true); assert.equal((await service.call('list')).sessions.length, 0); await service.close();
});
test('pre-aborted player calls do not touch an existing connection or controls', async () => {
  const { service, session, bot } = await fixture(); const controller = new AbortController(); controller.abort();
  const cleared = bot.controlsCleared;
  await assert.rejects(service.call('move', { session, durationMs: 10, signal: controller.signal }), { code: 'CANCELLED' });
  await assert.rejects(service.call('interact', { session, signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(bot.controlsCleared, cleared); assert.equal(bot.quitCalled, false); await service.close();
});
test('stop also aborts an incomplete connection without leaving a registered orphan', async () => {
  const bot = new FakeBot(), root = await mkdtemp(join(tmpdir(), 'mct-player-stop-connect-'));
  const service = new PlayerService({ stateDir: root, artifactDir: root }, { mineflayer: { testedVersions: ['1.20.1'], createBot: () => bot }, pathfinder: {} });
  const operation = service.call('connect', { version: '1.20.1' });
  const session = (await service.call('list')).sessions[0].sessionId; await service.call('stop', { session });
  await assert.rejects(operation, { code: 'CANCELLED' }); assert.equal(bot.quitCalled, true); assert.deepEqual((await service.call('list')).sessions, []); await service.close();
});
test('abort before Mineflayer plugin injection uses its immediate end API when quit is absent', async () => {
  const bot = new FakeBot(); let ended = false;
  (bot as any).quit = undefined; (bot as any).end = () => { ended = true; bot.emit('end'); };
  const root = await mkdtemp(join(tmpdir(), 'mct-player-preinject-'));
  const service = new PlayerService({ stateDir: root, artifactDir: root }, { mineflayer: { testedVersions: ['1.20.1'], createBot: () => bot }, pathfinder: {} });
  const controller = new AbortController(), operation = service.call('connect', { version: '1.20.1', signal: controller.signal }); controller.abort();
  await assert.rejects(operation, { code: 'CANCELLED' }); assert.equal(ended, true); assert.deepEqual((await service.call('list')).sessions, []); await service.close();
});
test('inventory abort and stop during container open close the owned connection before returning', async () => {
  for (const action of ['inventory', 'interact']) {
    const { service, session, bot } = await fixture(); const controller = new AbortController();
    (bot as any).inventory.slots = [null]; (bot as any).clickWindow = () => new Promise(() => {});
    (bot as any).blockAt = () => ({ name: 'chest' }); (bot as any).openContainer = () => new Promise(() => {});
    const args = action === 'inventory' ? { operation: 'click', slot: 0 } : { operation: 'open', position: { x: 1, y: 1, z: 0 } };
    const operation = service.call(action, { session, ...args, signal: controller.signal });
    if (action === 'inventory') controller.abort(); else await service.call('stop', { session });
    await assert.rejects(operation, { code: 'CANCELLED' });
    assert.equal(bot.quitCalled, true); assert.equal((await service.call('observe', { session })).state, 'disconnected'); await service.close();
  }
});
test('capture abort during browser launch waits for launch cleanup and preserves an existing viewer', async () => {
  let launch!: (value: any) => void; let closed = false; let viewerClosed = false;
  const { service, session, root } = await fixture(new FakeBot(), { playwright: { chromium: { launch: () => new Promise(resolve => { launch = resolve; }) } } });
  (service as any).sessions.get(session).viewer = { url: 'http://127.0.0.1:1', assetsVersion: '1.20.1', close: async () => { viewerClosed = true; } };
  const controller = new AbortController(); let settled = false;
  const operation = service.call('capture', { session, signal: controller.signal }).finally(() => { settled = true; });
  controller.abort(); await new Promise(r => setImmediate(r)); assert.equal(settled, false);
  launch({ close: async () => { await new Promise(r => setTimeout(r, 10)); closed = true; } });
  await assert.rejects(operation, { code: 'CANCELLED' }); assert.equal(closed, true); assert.equal(viewerClosed, false);
  assert.deepEqual(await readdir(join(root, 'artifacts')).catch(() => []), []); await service.close();
});
test('capture stop closes an in-progress render page and returns cancellation after cleanup', async () => {
  let rejectRender!: (error: Error) => void; let started!: () => void; const rendering = new Promise<void>(r => { started = r; }); let closed = false;
  const page = { on() {}, goto: async () => {}, waitForFunction: () => { started(); return new Promise((_r, reject) => { rejectRender = reject; }); } };
  const { service, session } = await fixture(new FakeBot(), { playwright: { chromium: { launch: async () => ({ newPage: async () => page, close: async () => { closed = true; rejectRender(new Error('Target closed')); } }) } } });
  (service as any).sessions.get(session).viewer = { url: 'http://127.0.0.1:1', assetsVersion: '1.20.1', close: async () => {} };
  const operation = service.call('capture', { session }); await rendering; await service.call('stop', { session });
  await assert.rejects(operation, { code: 'CANCELLED' }); assert.equal(closed, true); await service.close();
});
test('loopback viewer captures real meshed chunks with version provenance', { skip: !process.env.MCT_TEST_BROWSER, timeout: 60000 }, async () => {
  const bot = new FakeBot();
  const Chunk = require('prismarine-chunk')('1.20.1'); const World = require('prismarine-world')('1.20.1');
  const data = require('minecraft-data')('1.20.1'); const chunk = new Chunk();
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) chunk.setBlockStateId(new Vec3(x, 0, z), data.blocksByName.stone.defaultState);
  for (let y = 1; y < 5; y++) chunk.setBlockStateId(new Vec3(4, y, 4), data.blocksByName.gold_block.defaultState);
  bot.world = new World(); await bot.world.setColumn(0, 0, chunk);
  const { service, session } = await fixture(bot);
  try {
    const result = await service.call('capture', { session, width: 320, height: 240, timeoutMs: 45000 });
    assert.equal(result.source, 'prismarine-viewer'); assert.equal(result.assetsVersion, '1.20.1');
    assert.match(result.rendererUrl, /^http:\/\/127\.0\.0\.1:/);
    const png = await readFile(result.imagePath); assert.deepEqual([...png.subarray(0, 4)], [137, 80, 78, 71]);
  } finally { await service.close(); }
});
