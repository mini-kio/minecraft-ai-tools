import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServerService, MANIFEST_URL, officialUrl, verifyHash, parseJavaVersion, releaseTargets, assertSafeWorld } from '../src/servers/index.js';

const digest = (v: Uint8Array | string) => createHash('sha1').update(v).digest('hex');
const jar = Buffer.from('mock server jar verified with official checksum');
const metadata = JSON.stringify({ javaVersion: { majorVersion: 17 }, downloads: { server: { url: 'https://piston-data.mojang.com/server.jar', sha1: digest(jar), size: jar.length } } });
const entry = { id: '1.20', type: 'release', url: 'https://piston-meta.mojang.com/1.20.json', sha1: digest(metadata), releaseTime: '2023-06-07T00:00:00Z' };
const manifest = { latest: { release: '1.20' }, versions: [entry] };
const fakeFetch = (async (url: string) => {
  if (url === MANIFEST_URL) return new Response(JSON.stringify(manifest));
  if (url === entry.url) return new Response(metadata);
  if (url === 'https://piston-data.mojang.com/server.jar') return new Response(jar);
  throw new Error(`Unexpected URL ${url}`);
}) as any;
async function fixture(deps: any = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mct-server-'));
  return { root, service: new ServerService({ stateDir: root, artifactDir: join(root, 'artifacts') }, { fetch: fakeFetch, ...deps }) };
}
class FakeProcess extends EventEmitter {
  pid = 54321; exitCode: number | null = null; killed = false; stdout = new PassThrough(); stderr = new PassThrough(); commands: string[] = [];
  stdin = new Writable({ write: (data, _encoding, callback) => {
    this.commands.push(String(data)); callback();
    if (String(data) === 'stop\n') setImmediate(() => { this.exitCode = 0; this.emit('exit', 0, null); });
  } });
  kill() { this.killed = true; this.exitCode = 1; this.emit('exit', 1, 'SIGTERM'); return true; }
}
test('official URL validation disallows insecure or unrelated hosts and rejects corrupt bytes', () => {
  assert.equal(officialUrl(entry.url).hostname, 'piston-meta.mojang.com');
  for (const url of ['http://piston-meta.mojang.com/data', 'https://piston-meta.mojang.com.evil.test/a', 'https://username@piston-data.mojang.com/a']) assert.throws(() => officialUrl(url), { code: 'UNTRUSTED_DOWNLOAD' });
  assert.equal(verifyHash(jar, digest(jar)), digest(jar));
  assert.throws(() => verifyHash(Buffer.from('corrupt'), digest(jar)), { code: 'INTEGRITY_FAILED' });
  assert.throws(() => verifyHash(jar, '0'), { code: 'INVALID_CHECKSUM' });
});
test('Java parsing handles legacy, modern and early access version strings', () => {
  assert.equal(parseJavaVersion('openjdk version "21.0.2" 2024-01-16')?.major, 21);
  assert.equal(parseJavaVersion('java version "1.8.0_392"')?.major, 8);
  assert.equal(parseJavaVersion('openjdk 25-ea 2025-09-16')?.major, 25);
  assert.equal(parseJavaVersion('not Java'), null);
});
test('target releases are derived dynamically from official dates, exclude snapshots', () => {
  const targets = releaseTargets([entry, { ...entry, id: '26.3', releaseTime: '2026-09-01T00:00:00Z' }, { ...entry, id: '26w01a', type: 'snapshot' }, { ...entry, id: '1.19', releaseTime: '2022-01-01T00:00:00Z' }]);
  assert.deepEqual(targets.map(x => x.id), ['1.20', '26.3']);
});
test('EULA is explicit, server archives are verified, world copy preserves source', async () => {
  const { root, service } = await fixture();
  await assert.rejects(service.call('create', { version: '1.20' }), { code: 'EULA_REQUIRED' });
  const source = join(root, 'original'); await mkdir(source); await writeFile(join(source, 'level.dat'), 'original bytes');
  const created = await service.call('create', { version: '1.20', acceptEula: true, world: source });
  assert.equal(await readFile(join(source, 'level.dat'), 'utf8'), 'original bytes');
  assert.equal(await readFile(join(created.directory, 'world', 'level.dat'), 'utf8'), 'original bytes');
  const properties = await readFile(join(created.directory, 'server.properties'), 'utf8');
  assert.match(properties, /server-ip=127\.0\.0\.1/); assert.match(properties, /online-mode=false/);
  assert.match(await readFile(join(created.directory, 'eula.txt'), 'utf8'), /eula=true/);
  assert.equal(created.checksum, digest(jar)); assert.equal(created.version, '1.20');
  await assert.rejects(assertSafeWorld(source, join(source, 'nested')), { code: 'UNSAFE_WORLD_COPY' });
  await service.close();
});
test('corrupt server and metadata downloads never register a server', async () => {
  for (const target of ['metadata', 'jar']) {
    const { service } = await fixture({ fetch: async (url: string) => (target === 'metadata' && url === entry.url) || (target === 'jar' && url.endsWith('/server.jar')) ? new Response('broken') : fakeFetch(url) });
    await assert.rejects(service.call('create', { version: '1.20', acceptEula: true }), { code: 'INTEGRITY_FAILED' });
    assert.deepEqual((await service.call('list')).sessions, []); await service.close();
  }
});
test('parallel provisioning persists both isolated sessions and reload does not start them', async () => {
  const { root, service } = await fixture();
  const created = await Promise.all([service.call('create', { version: '1.20', acceptEula: true }), service.call('create', { version: '1.20', acceptEula: true })]);
  assert.notEqual(created[0].directory, created[1].directory);
  await service.close();
  const restored = new ServerService({ stateDir: root, artifactDir: root }, { fetch: fakeFetch });
  const [a, b] = await Promise.all([restored.call('list'), restored.call('list')]);
  assert.equal(a.sessions.length, 2); assert.equal(b.sessions.length, 2); assert.equal(a.sessions[0].state, 'stopped');
  await restored.close();
});
test('managed process readiness, console channel and graceful stop are observable', async () => {
  const child = new FakeProcess(); let spawnArgs: any[] = [];
  const { service } = await fixture({ discoverJava: async () => [{ path: 'mock-java', major: 17, version: '17' }], spawn: (...args: any[]) => { spawnArgs = args; return child; } });
  const created = await service.call('create', { version: '1.20', acceptEula: true }); const session = created.sessionId;
  const started = await service.call('start', { session, memoryMb: 512 });
  assert.equal(started.state, 'starting'); assert.equal(spawnArgs[2].shell, false); assert.equal(spawnArgs[2].windowsHide, true);
  assert.ok(spawnArgs[1].includes('-Dfile.encoding=UTF-8'));
  child.stdout.write('[Server thread/INFO]: Done (0.123s)! For help, type "help"\n');
  await new Promise(r => setImmediate(r));
  assert.equal((await service.call('observe', { session })).state, 'running');
  await service.call('command', { session, text: 'say hello' }); assert.equal(child.commands[0], 'say hello\n');
  assert.match(JSON.stringify((await service.call('logs', { session })).lines), /Done/);
  await assert.rejects(service.call('command', { session, text: 'say hello\nstop' }), { code: 'INVALID_ARGUMENT' });
  const stopped = await service.call('stop', { session }); assert.equal(stopped.state, 'stopped'); assert.equal(child.commands.at(-1), 'stop\n');
  await service.close();
});
test('invalid startup timeouts fail before discovering Java or spawning an owned server',async()=>{
  let discovered=0,spawned=0;
  const {service}=await fixture({discoverJava:async()=>{discovered++;return[{path:'mock-java',major:17,version:'17'}];},spawn:()=>{spawned++;return new FakeProcess();}});
  const created=await service.call('create',{version:'1.20',acceptEula:true});
  for(const timeoutMs of [0,-1,NaN,Infinity,1.5,300001])await assert.rejects(service.call('start',{session:created.sessionId,timeoutMs}),{code:'INVALID_ARGUMENT'});
  assert.equal(discovered,0);assert.equal(spawned,0);assert.equal((await service.call('observe',{session:created.sessionId})).state,'created');await service.close();
});
test('a server already terminated by SIGKILL can stop without waiting and restart with a new process',async()=>{
  const children:FakeProcess[]=[];
  const {service}=await fixture({discoverJava:async()=>[{path:'mock-java',major:17,version:'17'}],spawn:()=>{const child=new FakeProcess();children.push(child);return child;}});
  const created=await service.call('create',{version:'1.20',acceptEula:true}),session=created.sessionId;
  await service.call('start',{session});const child=children[0] as any;child.signalCode='SIGKILL';child.emit('exit',null,'SIGKILL');
  assert.equal((await service.call('stop',{session,force:true,timeoutMs:1})).state,'failed');assert.deepEqual(child.commands,[]);
  assert.equal((await service.call('start',{session})).state,'starting');assert.equal(children.length,2);await service.close();
});

async function assertNoPartialServers(root: string, service: ServerService) {
  assert.deepEqual((await service.call('list')).sessions, []);
  const entries = await readdir(join(root, 'servers')).catch(() => []);
  assert.equal(entries.some(name => name !== 'index.json'), false, `Unexpected server remnants: ${entries}`);
}
test('cancelling manifest headers and response body stops the underlying read', async () => {
  for (const phase of ['headers', 'body']) {
    let entered!: () => void; const started = new Promise<void>(r => { entered = r; }); let cancelled = false;
    const controller = new AbortController();
    const { root, service } = await fixture({ fetch: async (_url: string, options: any) => {
      entered();
      if (phase === 'headers') return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { cancelled = true; reject(new DOMException('aborted', 'AbortError')); }, { once: true }));
      return new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from('{')); }, cancel() { cancelled = true; } }));
    } });
    const operation = service.call('create', { version: '1.20', acceptEula: true, signal: controller.signal });
    await started; controller.abort(); await assert.rejects(operation, { code: 'CANCELLED' });
    assert.equal(cancelled, true); await assertNoPartialServers(root, service); await service.close();
  }
});
test('cancelled archive streams remove staging directories and never register sessions', async () => {
  const controller = new AbortController(); let bodyCancelled = false; let pulls = 0;
  const { root, service } = await fixture({ fetch: async (url: string) => url.endsWith('/server.jar') ? new Response(new ReadableStream({ pull(c) { pulls++; if (pulls === 1) c.enqueue(jar.subarray(0, 10)); else controller.abort(); }, cancel() { bodyCancelled = true; } })) : fakeFetch(url) });
  await assert.rejects(service.call('create', { version: '1.20', acceptEula: true, signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(bodyCancelled, true); await assertNoPartialServers(root, service); await service.close();
});
test('cancelled world copy releases streams, removes partial world and preserves source bytes', async () => {
  const { root, service } = await fixture(); const source = join(root, 'original-world'); await mkdir(source);
  const bytes = Buffer.alloc(1024 * 1024, 73); await writeFile(join(source, 'level.dat'), bytes);
  const controller = new AbortController(); let chunks = 0;
  await assert.rejects(service.call('create', { version: '1.20', acceptEula: true, world: source, signal: controller.signal, onProgress: (phase: string) => { if (phase === 'world-copy-chunk' && ++chunks === 2) controller.abort(); } }), { code: 'CANCELLED' });
  assert.ok(chunks >= 2); assert.equal(digest(await readFile(join(source, 'level.dat'))), digest(bytes));
  await assertNoPartialServers(root, service); await service.close();
});
test('cancellation during final registration rolls back the index and committed directory', async () => {
  const { root, service } = await fixture(); const controller = new AbortController();
  await assert.rejects(service.call('create', { version: '1.20', acceptEula: true, signal: controller.signal, onProgress: (phase: string) => { if (phase === 'complete') controller.abort(); } }), { code: 'CANCELLED' });
  await assertNoPartialServers(root, service); assert.deepEqual(JSON.parse(await readFile(join(root, 'servers', 'index.json'), 'utf8')), []); await service.close();
});
test('abortable start waits for cleanup and stops only the process owned by that start', async () => {
  const children: FakeProcess[] = [];
  const { service } = await fixture({ discoverJava: async () => [{ path: 'mock-java', major: 17, version: '17' }], spawn: () => { const child = new FakeProcess(); children.push(child); return child; } });
  const a = await service.call('create', { version: '1.20', acceptEula: true }); const b = await service.call('create', { version: '1.20', acceptEula: true });
  await service.call('start', { session: a.sessionId });
  const controller = new AbortController();
  await assert.rejects(service.call('start', { session: b.sessionId, signal: controller.signal, onProgress: (phase: string) => { if (phase === 'starting') controller.abort(); } }), { code: 'CANCELLED' });
  assert.equal(children[1].exitCode, 0); assert.ok(children[1].commands.includes('stop\n'));
  assert.equal(children[0].exitCode, null); assert.equal(children[0].commands.length, 0);
  await service.close();
});
test('signal-bearing start resolves after actual readiness and stop force waits for process exit', async () => {
  const child = new FakeProcess();
  const { service } = await fixture({ discoverJava: async () => [{ path: 'mock-java', major: 17, version: '17' }], spawn: () => { setTimeout(() => child.stdout.write('Done (0.1s)! For help, type help\n'), 10); return child; } });
  const server = await service.call('create', { version: '1.20', acceptEula: true });
  const ready = await service.call('start', { session: server.sessionId, signal: new AbortController().signal }); assert.equal(ready.state, 'running');
  child.stdin = new Writable({ write(_data, _encoding, callback) { callback(); } });
  let killed = false;
  child.kill = () => { killed = true; setTimeout(() => { child.exitCode = 1; child.emit('exit', 1, 'SIGKILL'); }, 20); return true; };
  await service.call('stop', { session: server.sessionId, force: true, timeoutMs: 1 }); assert.equal(killed, true); assert.equal(child.exitCode, 1);
  await service.close();
});
test('closing the service aborts active provisioning and waits until staging cleanup is complete', async () => {
  let entered!: () => void; const downloading = new Promise<void>(r => { entered = r; }); let cancelled = false;
  const { root, service } = await fixture({ fetch: async (url: string) => url.endsWith('/server.jar') ? new Response(new ReadableStream({ start(c) { c.enqueue(jar.subarray(0, 5)); entered(); }, cancel() { cancelled = true; } })) : fakeFetch(url) });
  const created = service.call('create', { version: '1.20', acceptEula: true }).catch((e: any) => e.code);
  await downloading; await service.close(); assert.equal(await created, 'CANCELLED'); assert.equal(cancelled, true);
  const restored = new ServerService({ stateDir: root, artifactDir: root }, { fetch: fakeFetch });
  await assertNoPartialServers(root, restored); await restored.close();
});
test('a pre-aborted start cannot send stop to an already running server', async () => {
  const child = new FakeProcess(); const { service } = await fixture({ discoverJava: async () => [{ path: 'mock-java', major: 17, version: '17' }], spawn: () => child });
  const created = await service.call('create', { version: '1.20', acceptEula: true }); await service.call('start', { session: created.sessionId });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(service.call('start', { session: created.sessionId, signal: controller.signal }), { code: 'CANCELLED' });
  assert.equal(child.commands.length, 0); assert.equal(child.exitCode, null); await service.close();
});
test('runtime mismatch and changed isolation fail before launching Java', async () => {
  const { service } = await fixture({ discoverJava: async () => [{ path: 'old-java', major: 8, version: '8' }] });
  const created = await service.call('create', { version: '1.20', acceptEula: true }); const session = created.sessionId;
  await assert.rejects(service.call('start', { session }), { code: 'JAVA_REQUIRED' });
  await writeFile(join(created.directory, 'server.properties'), 'server-ip=0.0.0.0\nonline-mode=false\n');
  await assert.rejects(service.call('start', { session }), { code: 'ISOLATION_CHANGED' }); await service.close();
});
test('RCON is a distinct admin channel and password never appears in session output', async () => {
  const commands: string[] = []; let closed = false;
  const { service } = await fixture({ rconConnect: async (options: any) => { assert.equal(options.password, 'secret-value'); return { send: async (cmd: string) => { commands.push(cmd); return 'Done'; }, end: async () => { closed = true; } }; } });
  const attached = await service.call('attach', { host: 'example.test', password: 'secret-value', version: '1.20' });
  assert.equal(attached.host, 'example.test'); assert.doesNotMatch(JSON.stringify(attached), /secret-value/);
  const result = await service.call('command', { session: attached.sessionId, text: '/list' });
  assert.equal(result.channel, 'admin-rcon'); assert.equal(result.response, 'Done'); assert.deepEqual(commands, ['list']);
  await service.close(); assert.equal(closed, true);
});
test('cancelled RCON attach awaits and closes a delayed owned connection before returning', async () => {
  let connect!: (value: any) => void; let closed = false, settled = false;
  let entered!: () => void; const connecting = new Promise<void>(r => { entered = r; });
  const { service } = await fixture({ rconConnect: () => new Promise(resolve => { connect = resolve; entered(); }) });
  const controller = new AbortController();
  const operation = service.call('attach', { password: 'test-secret', signal: controller.signal }).finally(() => { settled = true; });
  await connecting; controller.abort(); await new Promise(r => setImmediate(r)); assert.equal(settled, false);
  connect({ end: async () => { await new Promise(r => setTimeout(r, 10)); closed = true; } });
  await assert.rejects(operation, { code: 'CANCELLED' }); assert.equal(closed, true); assert.deepEqual((await service.call('list')).sessions, []); await service.close();
});
test('cancelled RCON response closes its connection and leaves the attached session stopped', async () => {
  let closed = false;
  let entered!: () => void; const sending = new Promise<void>(r => { entered = r; });
  const { service } = await fixture({ rconConnect: async () => ({ send: () => { entered(); return new Promise(() => {}); }, end: async () => { closed = true; } }) });
  const attached = await service.call('attach', { password: 'test-secret' }), controller = new AbortController();
  const operation = service.call('command', { session: attached.sessionId, text: 'list', signal: controller.signal }); await sending; controller.abort();
  await assert.rejects(operation, { code: 'CANCELLED' }); assert.equal(closed, true); assert.equal((await service.call('observe', { session: attached.sessionId })).state, 'stopped'); await service.close();
});
test('an unavailable exact Paper release reports its availability instead of selecting another build', async () => {
  const { root, service } = await fixture({ fetch: async (url: string) => url.startsWith('https://fill.papermc.io/') ? new Response('{}', { status: 404 }) : fakeFetch(url) });
  await assert.rejects(service.call('create', { version: '1.20', software: 'paper', acceptEula: true }), { code: 'PAPER_NOT_AVAILABLE' });
  await assertNoPartialServers(root, service); await service.close();
});
