import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, readdir, lstat, rename, realpath, rm, unlink } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve, join, isAbsolute, relative, sep } from 'node:path';
import { createServer } from 'node:net';
import { Args, Service, ServiceOptions, ToolError, fail, finite, id, required } from '../contracts.js';

const require = createRequire(import.meta.url);
const runFile = promisify(execFile);
export const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
export interface VersionEntry { id: string; type: string; url: string; sha1: string; releaseTime: string; }
export interface JavaRuntime { path: string; major: number; version: string; }
interface TestServer {
  id: string; kind: 'managed' | 'rcon'; version: string; software: string; directory?: string;
  javaMajor?: number; host?: string; port: number; acceptedEula?: boolean; process?: ChildProcess;
  state: 'created' | 'starting' | 'running' | 'stopped' | 'failed' | 'attached';
  logs: { at: string; stream: string; line: string }[]; pid?: number; lastError?: string;
  rcon?: any; logWrite?: Promise<void>;
}
export interface ServerDependencies {
  fetch?: typeof fetch;
  spawn?: typeof spawn;
  discoverJava?: (path?: string, signal?: AbortSignal) => Promise<JavaRuntime[]>;
  rconConnect?: (options: any) => Promise<any>;
}
export function officialUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || !['piston-meta.mojang.com', 'piston-data.mojang.com', 'launcher.mojang.com', 'launchermeta.mojang.com'].includes(url.hostname)) fail('UNTRUSTED_DOWNLOAD', 'Only official HTTPS Mojang download hosts are allowed', { hostname: url.hostname });
  return url;
}
export function verifyHash(bytes: Uint8Array, expected: string, algorithm: 'sha1' | 'sha256' = 'sha1'): string {
  if (!new RegExp(`^[0-9a-f]{${algorithm === 'sha1' ? 40 : 64}}$`, 'i').test(expected)) fail('INVALID_CHECKSUM', `Invalid ${algorithm} checksum`);
  const actual = createHash(algorithm).update(bytes).digest('hex');
  if (actual !== expected.toLowerCase()) fail('INTEGRITY_FAILED', 'Downloaded bytes did not match the official checksum', { expected, actual, algorithm });
  return actual;
}
export function parseJavaVersion(text: string): { major: number; version: string } | null {
  const m = text.match(/(?:openjdk|java) version\s+"([^\"]+)"/i) ?? text.match(/(?:openjdk|java)\s+(\d[\w.+_-]*)/i);
  if (!m) return null;
  const parts = m[1].split('.'); const major = Number.parseInt(parts[0] === '1' ? parts[1] : parts[0], 10);
  return Number.isInteger(major) && major > 0 ? { major, version: m[1] } : null;
}
export function releaseTargets(entries: VersionEntry[]): VersionEntry[] {
  const lower = entries.find(v => v.id === '1.20' && v.type === 'release');
  if (!lower) fail('MANIFEST_INVALID', 'Official manifest does not contain the 1.20 lower bound');
  const time = Date.parse(lower.releaseTime);
  return entries.filter(v => v.type === 'release' && Date.parse(v.releaseTime) >= time).sort((a, b) => Date.parse(a.releaseTime) - Date.parse(b.releaseTime));
}
export function abortServerOperation(signal?: AbortSignal): void {
  if (signal?.aborted) fail('CANCELLED', 'Server operation was cancelled');
}
async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  abortServerOperation(signal);
  let listener: (() => void) | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { listener = () => reject(new ToolError('CANCELLED', 'Server operation was cancelled')); signal?.addEventListener('abort', listener, { once: true }); if (signal?.aborted) listener(); })]); }
  finally { if (listener) signal?.removeEventListener('abort', listener); }
}
export async function discoverJava(explicit?: string, signal?: AbortSignal): Promise<JavaRuntime[]> {
  abortServerOperation(signal);
  const candidates = new Set<string>();
  if (explicit) candidates.add(explicit);
  else {
    candidates.add('java');
    for (const envName of ['JAVA_HOME', 'JDK_HOME', 'JAVA_17_HOME', 'JAVA_21_HOME', 'JAVA_25_HOME']) if (process.env[envName]) candidates.add(join(process.env[envName]!, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
    const roots = process.platform === 'win32' ? [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Java'), join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Eclipse Adoptium'), join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft'), join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Eclipse Adoptium'), join(process.env.USERPROFILE ?? '', '.jdks')] : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines'];
    for (const root of roots) {
      try { for (const d of await readdir(root, { withFileTypes: true })) if (d.isDirectory()) {
        candidates.add(join(root, d.name, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
        if (process.platform === 'darwin') candidates.add(join(root, d.name, 'Contents', 'Home', 'bin', 'java'));
      } } catch {}
    }
  }
  const results = await Promise.all([...candidates].map(async path => {
    try { const { stdout, stderr } = await runFile(path, ['-version'], { timeout: 5000, windowsHide: true, signal }); const version = parseJavaVersion(`${stdout}\n${stderr}`); return version ? { path, ...version } : null; } catch { return null; }
  }));
  abortServerOperation(signal);
  return results.filter((x): x is JavaRuntime => !!x);
}
export async function assertSafeWorld(source: string, destination: string, signal?: AbortSignal): Promise<string> {
  abortServerOperation(signal);
  const src = await realpath(resolve(source)); const dst = resolve(destination);
  const inside = (parent: string, child: string) => { const rel = relative(parent, child); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)); };
  if (!isAbsolute(src) || inside(src, dst) || inside(dst, src)) fail('UNSAFE_WORLD_COPY', 'Source and destination must be separate directories', { source: src, destination: dst });
  const walk = async (path: string) => {
    abortServerOperation(signal);
    const stat = await lstat(path); if (stat.isSymbolicLink()) fail('UNSAFE_WORLD_COPY', 'World copies cannot contain symbolic links or junctions', { path });
    if (stat.isDirectory()) for (const child of await readdir(path)) await walk(join(path, child));
  };
  await walk(src);
  if (!(await lstat(src)).isDirectory()) fail('INVALID_ARGUMENT', 'world must be a world directory');
  return src;
}
/** Copy only into a caller-owned fresh directory, with cancellation between files and stream chunks. */
export async function copyWorld(source: string, destination: string, signal?: AbortSignal, progress?: (phase: string) => void): Promise<void> {
  abortServerOperation(signal);
  const walk = async (src: string, dst: string) => {
    abortServerOperation(signal);
    const info = await lstat(src); abortServerOperation(signal);
    if (info.isSymbolicLink()) fail('UNSAFE_WORLD_COPY', 'World copies cannot contain symbolic links or junctions', { path: src });
    if (info.isDirectory()) { await mkdir(dst); for (const name of await readdir(src)) await walk(join(src, name), join(dst, name)); }
    else if (info.isFile()) {
      progress?.('world-copy-file'); abortServerOperation(signal);
      const meter = new Transform({ transform(chunk, _encoding, callback) { try { progress?.('world-copy-chunk'); abortServerOperation(signal); callback(null, chunk); } catch (error) { callback(error as Error); } } });
      await pipeline(createReadStream(src), meter, createWriteStream(dst, { flags: 'wx' }), { signal });
    }
    else fail('UNSAFE_WORLD_COPY', 'World copies support ordinary files and directories only', { path: src });
  };
  await walk(source, destination); abortServerOperation(signal);
}
const integer = (value: unknown, name: string, min: number, max: number) => { const n = finite(value, name); if (!Number.isInteger(n) || n < min || n > max) fail('INVALID_ARGUMENT', `${name} must be an integer ${min}..${max}`); return n; };
const textLine = (value: unknown) => { const text = String(required(value, 'command')); if (/[\r\n\0]/.test(text) || text.length > 32767) fail('INVALID_ARGUMENT', 'command must be one line'); return text; };

export class ServerService implements Service {
  private servers = new Map<string, TestServer>();
  private initialization?: Promise<void>;
  private saving: Promise<void> = Promise.resolve();
  private shutdown = new AbortController();
  private operations = new Set<Promise<any>>();
  private fetcher: typeof fetch;
  constructor(private options: ServiceOptions, private dependencies: ServerDependencies = {}) { this.fetcher = dependencies.fetch ?? fetch; }
  private root() { return join(this.options.stateDir, 'servers'); }
  private metadata(s: TestServer) { return { sessionId: s.id, kind: 'test-server', source: s.kind === 'rcon' ? 'rcon' : 'managed-server', version: s.version, software: s.software, state: s.state, directory: s.directory, host: s.host ?? '127.0.0.1', port: s.port, javaMajor: s.javaMajor, pid: s.pid, observedAt: new Date().toISOString(), lastError: s.lastError }; }
  private async init() {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => { try { const data = JSON.parse(await readFile(join(this.root(), 'index.json'), 'utf8'));
      for (const s of data) {
        if (typeof s.id !== 'string' || !/^server_[\w-]+$/.test(s.id)) continue;
        const directory = join(this.root(), s.id);
        this.servers.set(s.id, { ...s, directory, state: 'stopped', logs: [] });
      }
    } catch (e: any) { if (e.code !== 'ENOENT') throw e; } })();
    return this.initialization;
  }
  private async save() {
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(this.root(), { recursive: true });
      const records = [...this.servers.values()].filter(s => s.kind === 'managed').map(({ process: _p, logs: _l, rcon: _r, logWrite: _w, ...s }) => ({ ...s, state: 'stopped', pid: undefined }));
      const path = join(this.root(), 'index.json'); await writeFile(`${path}.tmp`, JSON.stringify(records, null, 2)); await rename(`${path}.tmp`, path);
    });
    return this.saving;
  }
  private get(args: Args) { const s = this.servers.get(required(args.session ?? args.sessionId, 'session')); if (!s) fail('SESSION_NOT_FOUND', 'Server session was not found'); return s; }
  private async request(url: string, allowed = true, signal?: AbortSignal): Promise<Response> {
    abortServerOperation(signal);
    if (allowed) officialUrl(url);
    const combined = AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
    const pending = this.fetcher(url, { signal: combined, redirect: 'error', headers: { 'User-Agent': process.env.MCT_DOWNLOAD_USER_AGENT || 'minecraft-ai-tools/0.1.0 (local Minecraft compatibility testing; https://docs.papermc.io/misc/downloads-service/)' } });
    void pending.then(response => { if (combined.aborted) void response.body?.cancel().catch(() => {}); }).catch(() => {});
    const r = await abortable(pending, signal);
    abortServerOperation(signal);
    if (!r.ok) fail('DOWNLOAD_FAILED', `Download returned HTTP ${r.status}`, { url, status: r.status });
    return r;
  }
  private async responseBytes(response: Response, signal?: AbortSignal, limit = 16 * 1024 * 1024): Promise<Uint8Array> {
    abortServerOperation(signal);
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    const onAbort = () => { void reader.cancel().catch(() => {}); }; signal?.addEventListener('abort', onAbort, { once: true });
    try { for (;;) { abortServerOperation(signal); const part = await abortable(reader.read(), signal); abortServerOperation(signal); if (part.done) break; size += part.value.byteLength; if (size > limit) fail('DOWNLOAD_TOO_LARGE', 'Response exceeds the configured byte limit'); chunks.push(part.value); } return Buffer.concat(chunks, size); }
    finally { signal?.removeEventListener('abort', onAbort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  private async responseJson(response: Response, signal?: AbortSignal): Promise<any> { return JSON.parse(Buffer.from(await this.responseBytes(response, signal)).toString('utf8')); }
  private async downloadFile(response: Response, file: string, expected: { hash: string; algorithm: 'sha1' | 'sha256'; size?: number }, signal?: AbortSignal) {
    abortServerOperation(signal);
    if (!response.body) fail('DOWNLOAD_FAILED', 'Server archive download has no body');
    const hash = createHash(expected.algorithm); let size = 0;
    const transform = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; if (size > 256 * 1024 * 1024) callback(new ToolError('DOWNLOAD_TOO_LARGE', 'Server archive exceeds 256 MiB')); else { hash.update(chunk); callback(null, chunk); } } });
    await pipeline(Readable.fromWeb(response.body as any), transform, createWriteStream(file, { flags: 'wx' }), { signal });
    abortServerOperation(signal);
    if (expected.size !== undefined && size !== expected.size) fail('INTEGRITY_FAILED', 'Server archive size differs from official metadata');
    const actual = hash.digest('hex'); if (actual !== expected.hash.toLowerCase()) fail('INTEGRITY_FAILED', 'Downloaded server archive failed its official checksum', { expected: expected.hash, actual, algorithm: expected.algorithm });
  }
  private async manifest(signal?: AbortSignal): Promise<{ latest: { release: string }; versions: VersionEntry[] }> {
    const data = await this.responseJson(await this.request(MANIFEST_URL, true, signal), signal);
    if (!Array.isArray(data.versions) || !data.latest?.release) fail('MANIFEST_INVALID', 'Official Minecraft manifest has an unexpected shape');
    return data;
  }
  async call(action: string, args: Args = {}): Promise<any> {
    if (args.signal !== undefined && !(args.signal instanceof AbortSignal)) fail('INVALID_ARGUMENT', 'signal must be an AbortSignal');
    const signal = AbortSignal.any([this.shutdown.signal, ...(args.signal ? [args.signal] : [])]);
    const operation = this.dispatch(action, { ...args, signal, __waitForReady: !!args.signal || args.wait === true }); this.operations.add(operation);
    try { return await operation; } catch (error: any) { if (error?.code === 'CANCELLATION_CLEANUP_FAILED') throw error; abortServerOperation(signal); throw error; }
    finally { this.operations.delete(operation); }
  }
  private async dispatch(action: string, args: Args): Promise<any> {
    const signal: AbortSignal = args.signal; abortServerOperation(signal);
    await this.init();
    abortServerOperation(signal);
    if (action === 'versions') {
      const manifest = await this.manifest(signal);
      const versions = releaseTargets(manifest.versions);
      return { source: MANIFEST_URL, latest: manifest.latest.release, versions: versions.map(v => ({ version: v.id, releaseTime: v.releaseTime, validation: 'unverified' })), count: versions.length, observedAt: new Date().toISOString() };
    }
    if (action === 'java') { const runtimes = await (this.dependencies.discoverJava ?? discoverJava)(args.javaPath, signal); abortServerOperation(signal); return { runtimes }; }
    if (action === 'create') return this.create(args);
    if (action === 'attach') {
      const host = String(args.host ?? '127.0.0.1'); const port = integer(args.port ?? 25575, 'port', 1, 65535);
      const password = String(required(args.password, 'password'));
      const connect = this.dependencies.rconConnect ?? ((o: any) => require('rcon-client').Rcon.connect(o));
      const pending = connect({ host, port, password, timeout: 10000 });
      let rcon: any;
      try { rcon = await abortable(pending, signal); abortServerOperation(signal); }
      catch (error) {
        if (signal.aborted) {
          // The injectable/static connector does not expose a socket until its
          // bounded connect promise settles. Await and close that owned result.
          const connected = await pending.catch(() => undefined);
          if (connected) try { await connected.end(); } catch (cleanup: any) { fail('CANCELLATION_CLEANUP_FAILED', 'Pending RCON connection could not be closed', { cause: cleanup.message }); }
        }
        throw error;
      }
      const s: TestServer = { id: id('rcon'), kind: 'rcon', version: String(args.version ?? 'unknown'), software: 'external', host, port, state: 'attached', logs: [], rcon };
      this.servers.set(s.id, s);
      return { ...this.metadata(s), host, authentication: 'RCON password is held in memory only' };
    }
    if (action === 'list') return { sessions: [...this.servers.values()].map(s => this.metadata(s)) };
    const s = this.get(args);
    if (action === 'observe') return this.metadata(s);
    if (action === 'start') return this.start(s, args);
    if (action === 'stop' || action === 'close' || action === 'disconnect') return this.stop(s, args);
    if (action === 'logs') {
      const count = integer(args.lines ?? 100, 'lines', 1, 2000);
      if (!s.logs.length && s.directory) { try { const stored = await readFile(join(s.directory, 'mct-output.log'), { encoding: 'utf8', signal }); abortServerOperation(signal); return { ...this.metadata(s), lines: stored.trimEnd().split('\n').slice(-count), logPath: join(s.directory, 'mct-output.log') }; } catch (error) { abortServerOperation(signal); } }
      return { ...this.metadata(s), lines: s.logs.slice(-count), logPath: s.directory && join(s.directory, 'mct-output.log') };
    }
    if (action === 'command') {
      const command = textLine(args.command ?? args.text).replace(/^\//, '');
      if (s.kind === 'rcon') {
        const pending = s.rcon.send(command);
        try { const response = await abortable(pending, signal); abortServerOperation(signal); return { ...this.metadata(s), channel: 'admin-rcon', response }; }
        catch (error) {
          if (signal.aborted) {
            try { await s.rcon.end(); s.state = 'stopped'; } catch (cleanup: any) { fail('CANCELLATION_CLEANUP_FAILED', 'RCON command connection could not be closed', { sessionId: s.id, cause: cleanup.message }); }
          }
          throw error;
        }
      }
      if (!s.process?.stdin?.writable || !['starting', 'running'].includes(s.state)) fail('NOT_RUNNING', 'Server is not running');
      await new Promise<void>((resolve, reject) => s.process!.stdin!.write(`${command}\n`, e => e ? reject(e) : resolve()));
      abortServerOperation(signal);
      return { ...this.metadata(s), sent: true, channel: 'server-console', response: 'Read server logs to confirm command execution.' };
    }
    fail('UNKNOWN_ACTION', `Unknown server action: ${action}`);
  }
  private async freePort(requested?: number): Promise<number> {
    const server = createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(requested ?? 0, '127.0.0.1', () => resolve()); });
    const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise<void>(resolve => server.close(() => resolve())); return port;
  }
  private async create(args: Args) {
    const signal: AbortSignal = args.signal;
    const progress = (phase: string) => { args.onProgress?.(phase); abortServerOperation(signal); };
    progress('manifest');
    if (args.acceptEula !== true) fail('EULA_REQUIRED', 'Creating a managed Minecraft server requires explicit acceptEula: true after reviewing https://aka.ms/MinecraftEULA', { eula: 'https://aka.ms/MinecraftEULA' });
    const requested = String(required(args.version, 'version'));
    const manifest = await this.manifest(signal); const entries = releaseTargets(manifest.versions);
    const version = requested === 'latest' ? manifest.latest.release : requested;
    const entry = entries.find(v => v.id === version);
    if (!entry) fail('UNSUPPORTED_VERSION', 'Choose an official release from 1.20 onwards', { requested, latest: manifest.latest.release });
    progress('version-metadata');
    const bytes = await this.responseBytes(await this.request(entry.url, true, signal), signal); verifyHash(bytes, entry.sha1);
    const meta = JSON.parse(Buffer.from(bytes).toString('utf8'));
    const software = String(args.software ?? 'vanilla');
    if (!['vanilla', 'paper'].includes(software)) fail('INVALID_ARGUMENT', 'software must be vanilla or paper');
    const javaMajor = integer(meta.javaVersion?.majorVersion ?? 17, 'javaMajor', 17, 100);
    const serverId = id('server'); const directory = join(this.root(), serverId), staging = join(this.root(), `.${serverId}.partial`);
    const port = await this.freePort(args.port === undefined ? undefined : integer(args.port, 'port', 1, 65535));
    progress('world-validation');
    const worldSource = args.world ? await assertSafeWorld(String(args.world), join(directory, 'world'), signal) : undefined;
    let download: { url: string; hash: string; algorithm: 'sha1' | 'sha256'; size?: number };
    if (software === 'vanilla') {
      const file = meta.downloads?.server; if (!file) fail('SERVER_NOT_AVAILABLE', 'This release has no official dedicated server download');
      officialUrl(file.url); download = { url: file.url, hash: file.sha1, algorithm: 'sha1', size: file.size };
    } else {
      // Fill v3 excludes experimental builds; never silently use a snapshot build.
      progress('paper-builds');
      let info: any;
      try { info = await this.responseJson(await this.request(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`, false, signal), signal); }
      catch (error: any) { if (error.code === 'DOWNLOAD_FAILED' && error.details?.status === 404) fail('PAPER_NOT_AVAILABLE', 'Official Paper API has no builds for this exact version', { version }); throw error; }
      const builds = Array.isArray(info) ? info : info.builds;
      const stable = builds?.filter((b: any) => b.channel === 'STABLE').sort((a: any, b: any) => Number(b.id) - Number(a.id))[0];
      const f = stable?.downloads?.['server:default'];
      if (!f?.url || !f.checksums?.sha256) fail('PAPER_NOT_AVAILABLE', 'No stable Paper build with SHA256 is available for this exact version', { version });
      const url = new URL(f.url); if (url.protocol !== 'https:' || !['fill-data.papermc.io', 'fill.papermc.io', 'api.papermc.io'].includes(url.hostname)) fail('UNTRUSTED_DOWNLOAD', 'Paper returned an unexpected download host');
      download = { url: f.url, hash: f.checksums.sha256, algorithm: 'sha256', size: f.size };
    }
    let staged = false, committed = false, registered = false;
    if (!new RegExp(`^[0-9a-f]{${download.algorithm === 'sha1' ? 40 : 64}}$`, 'i').test(download.hash)) fail('INVALID_CHECKSUM', 'Server archive metadata contains an invalid checksum');
    try {
      progress('download');
      await mkdir(this.root(), { recursive: true }); await mkdir(staging); staged = true;
      const response = await this.request(download.url, software === 'vanilla', signal);
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > 256 * 1024 * 1024 || (download.size && download.size > 256 * 1024 * 1024)) fail('DOWNLOAD_TOO_LARGE', 'Server archive exceeds 256 MiB');
      await this.downloadFile(response, join(staging, 'server.jar'), download, signal);
      if (worldSource) { progress('world-copy'); await copyWorld(worldSource, join(staging, 'world'), signal, progress); }
      progress('configuration');
      await writeFile(join(staging, 'eula.txt'), '# Accepted explicitly through mct test create --accept-eula\neula=true\n', { signal });
      await writeFile(join(staging, 'server.properties'), `server-ip=127.0.0.1\nserver-port=${port}\nonline-mode=false\nwhite-list=false\nenforce-whitelist=false\nenforce-secure-profile=false\nlevel-name=world\nspawn-protection=0\nview-distance=6\nsimulation-distance=4\nmax-players=8\nenable-rcon=false\nenable-query=false\n`, { signal });
      await writeFile(join(staging, 'provenance.json'), JSON.stringify({ manifest: MANIFEST_URL, metadataUrl: entry.url, metadataSha1: entry.sha1, serverUrl: download.url, checksum: download.hash, algorithm: download.algorithm, downloadedAt: new Date().toISOString(), worldSource, sourceWorldModified: false }, null, 2), { signal });
      progress('commit'); await rename(staging, directory); staged = false; committed = true; abortServerOperation(signal);
      const s: TestServer = { id: serverId, kind: 'managed', version, software, directory, javaMajor, port, acceptedEula: true, state: 'created', logs: [] };
      this.servers.set(s.id, s); registered = true; await this.save(); progress('complete');
      return { ...this.metadata(s), eula: 'accepted explicitly', isolation: 'loopback-only offline test server', sourceWorldModified: false, checksum: download.hash, validation: 'download integrity verified; gameplay compatibility unverified' };
    } catch (error) {
      const cleanupErrors: string[] = [];
      if (registered) { this.servers.delete(serverId); await this.save().catch(e => cleanupErrors.push(e.message)); }
      if (staged) await this.removeOwnedDirectory(staging).catch(e => cleanupErrors.push(e.message));
      if (committed) await this.removeOwnedDirectory(directory).catch(e => cleanupErrors.push(e.message));
      if (cleanupErrors.length) fail('CANCELLATION_CLEANUP_FAILED', 'Server provisioning failed and cleanup could not finish', { directory, staging, cleanupErrors });
      throw error;
    }
  }
  private async removeOwnedDirectory(directory: string) {
    const root = await realpath(this.root()), expected = resolve(directory);
    if (resolve(join(this.root(), relative(this.root(), expected))) !== expected || relative(resolve(this.root()), expected).includes(sep) || !/^\.?server_[\w-]+(?:\.partial)?$/.test(relative(resolve(this.root()), expected))) fail('UNSAFE_CLEANUP', 'Refusing cleanup outside an owned server directory');
    const stat = await lstat(expected).catch((e: any) => { if (e.code === 'ENOENT') return undefined; throw e; }); if (!stat) return;
    if (stat.isSymbolicLink()) { await unlink(expected); return; }
    const target = await realpath(expected), rel = relative(root, target);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || rel.includes(sep)) fail('UNSAFE_CLEANUP', 'Resolved cleanup target is outside the owned server root');
    await rm(target, { recursive: true, force: true });
  }
  private addLog(s: TestServer, stream: string, line: string) {
    const entry = { at: new Date().toISOString(), stream, line }; s.logs.push(entry); if (s.logs.length > 2000) s.logs.shift();
    if (s.directory) s.logWrite = (s.logWrite ?? Promise.resolve()).then(async () => {
      const { appendFile } = await import('node:fs/promises'); await appendFile(join(s.directory!, 'mct-output.log'), `[${entry.at}] [${stream}] ${line}\n`);
    }).catch(e => { s.lastError = `Unable to persist logs: ${e.message}`; });
    if (/Done \([\d.,]+s\)!/.test(line)) s.state = 'running';
  }
  private async start(s: TestServer, args: Args) {
    const signal: AbortSignal | undefined = args.signal; abortServerOperation(signal);
    const startupTimeout=integer(args.timeoutMs??180000,'timeoutMs',1,300000);
    if (s.kind !== 'managed') fail('INVALID_ACTION', 'Cannot start an externally attached RCON server');
    if (s.process && s.process.pid && s.process.exitCode === null && s.process.signalCode == null) fail('ALREADY_RUNNING', 'Server is already running or still exiting');
    const eula = await readFile(join(s.directory!, 'eula.txt'), { encoding: 'utf8', signal });
    if (!s.acceptedEula || !/^eula=true\s*$/m.test(eula)) fail('EULA_REQUIRED', 'The managed server must have explicitly accepted EULA');
    // Enforce isolation again even if someone changed server.properties since create.
    const properties = await readFile(join(s.directory!, 'server.properties'), { encoding: 'utf8', signal });
    if (!/^server-ip=127\.0\.0\.1\s*$/m.test(properties) || !/^online-mode=false\s*$/m.test(properties)) fail('ISOLATION_CHANGED', 'Managed test servers require server-ip=127.0.0.1 and online-mode=false');
    await this.freePort(s.port);
    const runtimes = await (this.dependencies.discoverJava ?? discoverJava)(args.javaPath, signal); abortServerOperation(signal);
    const runtime = runtimes.filter(r => r.major >= s.javaMajor!).sort((a, b) => a.major - b.major)[0];
    if (!runtime) fail('JAVA_REQUIRED', `Java ${s.javaMajor} or later is required`, { minimumMajor: s.javaMajor, discovered: runtimes, argument: 'javaPath' });
    const memory = integer(args.memoryMb ?? 2048, 'memoryMb', 512, 32768);
    const child = (this.dependencies.spawn ?? spawn)(runtime.path, ['-Dfile.encoding=UTF-8', `-Xms${Math.min(memory, 512)}M`, `-Xmx${memory}M`, '-jar', 'server.jar', 'nogui'], { cwd: s.directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    s.process = child; s.pid = child.pid; s.state = 'starting'; s.lastError = undefined;
    for (const [streamName, stream] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
      let pending = ''; stream?.setEncoding('utf8'); stream?.on('data', (chunk: string) => { pending += chunk; const lines = pending.split(/\r?\n/); pending = lines.pop() ?? ''; for (const line of lines) this.addLog(s, streamName, line); });
      stream?.on('end', () => { if (pending) this.addLog(s, streamName, pending); });
    }
    child.on('error', e => { s.lastError = e.message; s.state = 'failed'; });
    child.on('exit', (code, signal) => { s.state = code === 0 ? 'stopped' : 'failed'; if (code !== 0) s.lastError = `Server exited with code ${code}, signal ${signal}`; s.pid = undefined; });
    try {
      args.onProgress?.('starting'); abortServerOperation(signal);
      // A supplied signal belongs to a long-running caller/job, so retain that
      // ownership through readiness. Legacy calls without a signal stay nonblocking.
      if (args.__waitForReady) {
        const deadline = Date.now() + startupTimeout;
        const currentState = (): TestServer['state'] => s.state;
        while (currentState() !== 'running') {
          abortServerOperation(signal);
          if (currentState() === 'failed' || child.exitCode !== null) fail('START_FAILED', s.lastError || 'Server exited before becoming ready');
          if (Date.now() >= deadline) fail('START_TIMEOUT', 'Server did not become ready before the deadline');
          await abortable(new Promise<void>(r => setTimeout(r, 100)), signal);
        }
        abortServerOperation(signal);
      }
      return { ...this.metadata(s), java: runtime, readiness: 'Poll observe until state is running; inspect logs if state becomes failed.' };
    } catch (error) {
      // Only this invocation's process is eligible for cancellation cleanup.
      try { await this.stopOwned(s, child, 3000, true); }
      catch (cleanup: any) { fail('CANCELLATION_CLEANUP_FAILED', 'Owned server did not finish stopping after interrupted startup', { sessionId: s.id, pid: child.pid, cleanup: cleanup.message }); }
      throw error;
    }
  }
  private async stop(s: TestServer, args: Args) {
    abortServerOperation(args.signal);
    if (s.kind === 'rcon') { await s.rcon.end(); s.state = 'stopped'; abortServerOperation(args.signal); return this.metadata(s); }
    const child = s.process;
    if (!child || child.exitCode !== null) { s.state = 'stopped'; return this.metadata(s); }
    const timeout = integer(args.timeoutMs ?? 15000, 'timeoutMs', 1, 60000);
    const result = await this.stopOwned(s, child, timeout, args.force === true); abortServerOperation(args.signal); return result;
  }
  private async stopOwned(s: TestServer, child: ChildProcess, timeout: number, force: boolean) {
    if (s.process !== child) fail('PROCESS_OWNERSHIP_CHANGED', 'The server process changed while the operation was pending');
    if (child.exitCode !== null || child.signalCode != null || (!child.pid && s.state === 'failed')) { await s.logWrite; return this.metadata(s); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve, reject) => {
      let forced = false;
      const exited = () => { if (timer) clearTimeout(timer); resolve(); };
      const terminate = () => {
        if (!force) { child.removeListener('exit', exited); reject(new ToolError('STOP_TIMEOUT', 'Server did not stop in time; it is still tracked. Inspect logs or retry stop with force: true.')); return; }
        forced = true;
        // Attach the post-kill deadline first because mocked or fast children may
        // emit exit synchronously from kill(). Never report stop before exit.
        timer = setTimeout(() => { child.removeListener('exit', exited); reject(new ToolError('STOP_TIMEOUT', 'Owned server did not exit after forced termination')); }, 10000);
        child.kill('SIGKILL');
      };
      child.once('exit', exited);
      timer = setTimeout(terminate, timeout);
      if (child.stdin?.writable) child.stdin.write('stop\n', e => { if (e && !forced) { if (timer) clearTimeout(timer); terminate(); } });
      else { if (timer) clearTimeout(timer); terminate(); }
    });
    await s.logWrite; return this.metadata(s);
  }
  async close(): Promise<void> {
    this.shutdown.abort(); const operations = await Promise.allSettled([...this.operations]);
    await this.init();
    const stopping = await Promise.allSettled([...this.servers.values()].map(s => this.stop(s, { timeoutMs: 10000, force: true })));
    await this.save();
    const failures = [...operations.filter(r => r.status === 'rejected' && r.reason?.code === 'CANCELLATION_CLEANUP_FAILED'), ...stopping.filter(r => r.status === 'rejected')] as PromiseRejectedResult[];
    if (failures.length) fail('CANCELLATION_CLEANUP_FAILED', 'Server service shutdown could not finish all owned cleanup', { failures: failures.map(r => r.reason?.message ?? String(r.reason)) });
  }
}
