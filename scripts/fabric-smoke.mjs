#!/usr/bin/env node
/** Isolated developer QA client: dummy offline identity, no launcher credentials or existing saves. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const version = option('--version', '26.3');
const width=Number(option('--width','640')),height=Number(option('--height','480')),renderDistance=Number(option('--render-distance','3')),memory=Number(option('--memory-mb','1024'));
if(!Number.isInteger(width)||width<320||width>3840||!Number.isInteger(height)||height<240||height>2160||!Number.isInteger(renderDistance)||renderDistance<2||renderDistance>32||!Number.isInteger(memory)||memory<512||memory>8192)throw Error('Invalid isolated client dimensions or memory');
const javaHome = option('--java-home', process.env.JAVA_HOME);
if (!javaHome) throw new Error('--java-home is required');
const java = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
const jarTool = path.join(javaHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar');
const cache = path.join(root, 'work', 'fabric-tools');
const gameDir = path.resolve(option('--game-dir', path.join(cache, 'smoke-' + version)));
const libraries = path.join(cache, 'libraries');
const natives = path.join(gameDir, 'natives');
const assets = path.join(cache, 'assets');
await fs.mkdir(natives, { recursive: true }); await fs.mkdir(path.join(gameDir, 'mods'), { recursive: true });
async function download(url, target, sha1) {
  try { const bytes = await fs.readFile(target); if (!sha1 || crypto.createHash('sha1').update(bytes).digest('hex') === sha1) return bytes; } catch {}
  const response = await fetch(url); if (!response.ok) throw new Error(`${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer()); if (sha1 && crypto.createHash('sha1').update(bytes).digest('hex') !== sha1) throw new Error('SHA-1 mismatch: ' + url);
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); return bytes;
}
const manifest = JSON.parse((await fs.readFile(path.join(cache, 'versions.json'))).toString());
const entry = manifest.versions.find(v => v.id === version); if (!entry) throw new Error('Unknown official version');
const meta = JSON.parse((await download(entry.url, path.join(cache, version + '.json'), entry.sha1)).toString());
const profile = JSON.parse((await download(`https://meta.fabricmc.net/v2/versions/loader/${version}/0.19.5/profile/json`, path.join(cache, `profile-${version}.json`))).toString());
const client = path.join(cache, 'minecraft-' + version + '.jar'); await download(meta.downloads.client.url, client, meta.downloads.client.sha1);
function allowed(lib) {
  if (!lib.rules) return true; let allow = false;
  for (const rule of lib.rules) {
    const name = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    if (rule.os?.name && rule.os.name !== name) continue;
    if (rule.os?.arch && rule.os.arch !== (process.arch === 'x64' ? 'x86_64' : process.arch)) continue;
    if (rule.os?.version && !(new RegExp(rule.os.version).test('10.0'))) continue;
    allow = rule.action === 'allow';
  }
  return allow;
}
const tasks = [], classpath = [client];
// Fabric upgrades libraries such as ASM. Loading both versions can expose
// duplicate classes to Knot, so choose its Maven-coordinate override once.
const selectedLibraries = new Map();
for (const lib of [...meta.libraries, ...profile.libraries].filter(allowed)) {
  const [group, artifact, , classifier = ''] = lib.name.split(':');
  selectedLibraries.set(`${group}:${artifact}:${classifier}`, lib);
}
for (const lib of selectedLibraries.values()) {
  let artifact = lib.downloads?.artifact;
  if (!artifact) { const [group, name, version, classifier] = lib.name.split(':'); const p = `${group.replaceAll('.', '/')}/${name}/${version}/${name}-${version}${classifier ? '-' + classifier : ''}.jar`; artifact = { path: p, url: (lib.url ?? 'https://libraries.minecraft.net/') + p }; }
  const filename = path.join(libraries, artifact.path); classpath.push(filename); tasks.push(() => download(artifact.url, filename, artifact.sha1));
  if (lib.natives) {
    const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
    const classifier = lib.natives[os]?.replace('${arch}', process.arch === 'x64' ? '64' : '32');
    const native = lib.downloads?.classifiers?.[classifier];
    if (native) { const file = path.join(libraries, native.path); tasks.push(async () => { await download(native.url, file, native.sha1); await exec(jarTool, ['xf', file], { cwd: natives }); }); }
  }
}
let done = 0;
await Promise.all(Array.from({ length: 8 }, async () => { while (tasks.length) { await tasks.shift()(); done++; } }));
console.log(`Downloaded/verified ${done} library artifacts`);
const index = JSON.parse((await download(meta.assetIndex.url, path.join(assets, 'indexes', meta.assetIndex.id + '.json'), meta.assetIndex.sha1)).toString());
// A complete visual resource set is needed in modern clients; sound is muted for isolated QA.
const assetTasks = Object.entries(index.objects).filter(([name]) => !name.includes('/sounds/') && !name.endsWith('.ogg')).map(([, item]) => () => download(`https://resources.download.minecraft.net/${item.hash.slice(0, 2)}/${item.hash}`, path.join(assets, 'objects', item.hash.slice(0, 2), item.hash), item.hash));
await Promise.all(Array.from({ length: 6 }, async () => { while (assetTasks.length) await assetTasks.shift()(); }));
await fs.copyFile(path.join(root, 'bridges', 'fabric', 'dist', `mct-bridge-${version}.jar`), path.join(gameDir, 'mods', 'mct-bridge.jar'));
await fs.writeFile(path.join(gameDir, 'options.txt'), `version:0\nfullscreen:false\npauseOnLostFocus:false\noverrideWidth:${width}\noverrideHeight:${height}\nrenderDistance:${renderDistance}\nsimulationDistance:5\nmaxFps:30\nenableVsync:false\nsoundCategory_master:0.0\n`);
const command = [ `-Xmx${memory}M`, '-XX:ActiveProcessorCount=4', '--enable-native-access=ALL-UNNAMED', '--add-exports', 'java.base/jdk.internal.misc=ALL-UNNAMED', '-Djava.library.path=' + natives, '-Dfabric.gameJarPath=' + client, '-Dfabric.development=false', '-Dmct.discoveryDir=' + path.join(gameDir, '.mct'), '-cp', [...new Set(classpath)].join(path.delimiter), profile.mainClass, '--username', 'MctSmoke', '--version', version, '--gameDir', gameDir, '--assetsDir', assets, '--assetIndex', meta.assetIndex.id, '--uuid', '00000000000000000000000000000001', '--accessToken', '0', '--userType', 'legacy', '--versionType', 'release', '--width', String(width), '--height', String(height)];
if (option('--server')) command.push('--quickPlayMultiplayer', '127.0.0.1:' + option('--server'));
await fs.writeFile(path.join(gameDir, 'launch.json'), JSON.stringify({ java, args: command }, null, 2));
if (args.includes('--prepare-only')) { console.log('Prepared isolated client: ' + gameDir); process.exit(0); }
const log = await fs.open(path.join(gameDir, 'console.log'), 'w');
const child = spawn(java, command, { cwd: gameDir, windowsHide: true, detached: !args.includes('--stay'), stdio: ['ignore', log.fd, log.fd] }); child.unref();
await fs.writeFile(path.join(gameDir, 'process.json'), JSON.stringify({ pid: child.pid, startedAt: new Date().toISOString(), gameDir, version })); await log.close();
console.log(JSON.stringify({ pid: child.pid, gameDir, log: path.join(gameDir, 'console.log'), discoveryDir: path.join(gameDir, '.mct'), identity: 'offline MctSmoke (local QA only)' }));
if (args.includes('--stay')) { child.ref(); const exit = await new Promise(resolve => child.once('exit', (code, signal) => resolve({code,signal}))); await fs.writeFile(path.join(gameDir, 'exit.json'), JSON.stringify({...exit,at:new Date().toISOString()})); console.log(JSON.stringify(exit)); process.exitCode = exit.code ?? 1; }
