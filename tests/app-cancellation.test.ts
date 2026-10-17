import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { Application } from '../src/app.js';

const require = createRequire(import.meta.url), nbt = require('prismarine-nbt');
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mct-stage-job-cancel-'));
  const world = join(directory, 'source-world'), server = join(directory, 'owned-server');
  await mkdir(join(world, 'region'), { recursive: true }); await mkdir(server);
  const compressed = deflateSync(nbt.writeUncompressed({ name: '', type: 'compound', value: {
    DataVersion: { type: 'int', value: 3463 }, Status: { type: 'string', value: 'minecraft:full' },
    sections: { type: 'list', value: { type: 'compound', value: [{
      Y: { type: 'byte', value: 0 }, block_states: { type: 'compound', value: {
        palette: { type: 'list', value: { type: 'compound', value: [{ Name: { type: 'string', value: 'minecraft:stone' } }] } },
      } },
    }] } },
  } }));
  const region = Buffer.alloc(12288); region.writeUInt32BE((2 << 8) | 1, 0); region.writeUInt32BE(compressed.length + 1, 8192); region[8196] = 2; compressed.copy(region, 8197);
  const regionPath = join(world, 'region', 'r.0.0.mca'); await writeFile(regionPath, region);
  await writeFile(join(server, 'server.properties'), '');
  const app = new Application({ stateDir: join(directory, 'state'), artifactDir: join(directory, 'artifacts') });
  const map = await app.execute('map', 'open', { path: world, version: '1.20', textures: false });
  const finalObserve = deferred(), releaseObserve = deferred(), stopStarted = deferred(), releaseStop = deferred();
  let running = false, connected = false, observeCount = 0;
  app.bridges.peers.set('client-fixture', { id: 'client-fixture', kind: 'fabric', name: 'isolated test', version: '1.20', capabilities: [] });
  app.servers.call = async (action, args) => {
    if (action === 'create') { assert.equal(args?.world, world); return { sessionId: 'server-owned', directory: server }; }
    if (action === 'start') { running = true; return { state: 'running' }; }
    if (action === 'stop') { stopStarted.resolve(); await releaseStop.promise; running = false; return { state: 'stopped' }; }
    return {};
  };
  app.bridges.request = async (_peer, action) => {
    if (action === 'connect') { connected = true; return {}; }
    if (action === 'disconnect') { connected = false; return {}; }
    if (action !== 'observe') return {};
    observeCount++;
    if (observeCount === 1) return { connected: false };
    if (observeCount === 3) { finalObserve.resolve(); await releaseObserve.promise; }
    return { connected, screen: null, loading: false, player: { name: 'MctSmoke' } };
  };
  return { app, map, finalObserve, releaseObserve, stopStarted, releaseStop, regionPath, region, running: () => running, connected: () => connected };
}

test('cancelling native map staging during final observation awaits owned server cleanup before completion', async () => {
  const f = await fixture();
  try {
    const job = await f.app.execute('map', 'stage', { session: f.map.session, client: 'client-fixture', acceptEula: true, async: true, port: 25565 });
    await f.finalObserve.promise;
    assert.equal((await f.app.execute('job', 'cancel', { job: job.id, waitMs: 0 })).state, 'cancelling');
    f.releaseObserve.resolve(); await f.stopStarted.promise;
    assert.equal(f.running(), true); assert.equal((await f.app.execute('job', 'status', { job: job.id })).state, 'cancelling');
    f.releaseStop.resolve(); await f.app.jobs.jobs.get(job.id).settled;
    const finished = await f.app.execute('job', 'status', { job: job.id });
    assert.equal(finished.state, 'cancelled'); assert.equal(finished.error.code, 'CANCELLED');
    assert.equal(f.running(), false); assert.equal(f.connected(), false); assert.equal(f.app.nativeMaps.has(f.map.session), false);
    assert.deepEqual(await readFile(f.regionPath), f.region);
    assert.equal((await f.app.execute('map', 'observe', { session: f.map.session })).version, '1.20');
  } finally { f.releaseObserve.resolve(); f.releaseStop.resolve(); await f.app.close(); }
});

test('failed owned server cleanup after staging cancellation remains a failure rather than cancelled', async () => {
  const f = await fixture();
  try {
    const job = await f.app.execute('map', 'stage', { session: f.map.session, client: 'client-fixture', acceptEula: true, async: true, port: 25565 });
    await f.finalObserve.promise; await f.app.execute('job', 'cancel', { job: job.id, waitMs: 0 });
    f.releaseObserve.resolve(); await f.stopStarted.promise; f.releaseStop.reject(Object.assign(new Error('owned process still exiting'), { code: 'STOP_TIMEOUT' }));
    await f.app.jobs.jobs.get(job.id).settled;
    const finished = await f.app.execute('job', 'status', { job: job.id });
    assert.equal(finished.state, 'failed'); assert.equal(finished.error.code, 'CANCELLATION_CLEANUP_FAILED');
    assert.equal(f.app.nativeMaps.has(f.map.session), false); assert.deepEqual(await readFile(f.regionPath), f.region);
  } finally { f.releaseObserve.resolve(); f.releaseStop.resolve(); await f.app.close(); }
});
