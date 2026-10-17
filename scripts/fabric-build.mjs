#!/usr/bin/env node
/** Reproducible standalone javac/jar build; no Minecraft code is redistributed. */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; }
const javaHome = option('--java-home') ?? process.env.JAVA_HOME;
if (!javaHome) throw new Error('Pass --java-home <portable JDK 25 directory> or set JAVA_HOME');
const tool = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
const cache = path.join(root, 'work', 'fabric-tools');
const bridge = path.join(root, 'bridges', 'fabric');
const build = path.join(bridge, 'build');
const artifacts = path.join(bridge, 'dist');
await fs.mkdir(cache, { recursive: true }); await fs.mkdir(build, { recursive: true }); await fs.mkdir(artifacts, { recursive: true });
async function download(url, target, sha1) {
  try { const bytes = await fs.readFile(target); if (!sha1 || crypto.createHash('sha1').update(bytes).digest('hex') === sha1) return bytes; } catch {}
  const response = await fetch(url); if (!response.ok) throw new Error(`${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha1 && crypto.createHash('sha1').update(bytes).digest('hex') !== sha1) throw new Error(`SHA-1 mismatch: ${url}`);
  await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes); return bytes;
}
const manifest = JSON.parse((await download('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', path.join(cache, 'versions.json'))).toString());
const releases = manifest.versions.filter(v => v.type === 'release');
const end = releases.findIndex(v => v.id === '1.20');
if (end < 0) throw new Error('Minecraft 1.20 missing from official manifest');
const all = releases.slice(0, end + 1).reverse();
const selected = option('--versions')?.split(',');
const targets = all.filter(v => !selected || selected.includes(v.id));
if (!targets.length) throw new Error('No matching official versions');
const yarn = JSON.parse((await download('https://meta.fabricmc.net/v2/versions/yarn', path.join(cache, 'yarn-versions.json'))).toString());
const loaderVersion = '0.19.5';
const deps = [
  ['fabric-loader.jar', `https://maven.fabricmc.net/net/fabricmc/fabric-loader/${loaderVersion}/fabric-loader-${loaderVersion}.jar`],
  ['mixin.jar', 'https://maven.fabricmc.net/net/fabricmc/sponge-mixin/0.17.0%2Bmixin.0.8.7/sponge-mixin-0.17.0%2Bmixin.0.8.7.jar'],
  ['gson.jar', 'https://libraries.minecraft.net/com/google/code/gson/gson/2.10.1/gson-2.10.1.jar'],
];
await Promise.all(deps.map(([filename, url]) => download(url, path.join(cache, filename))));
const classpath = deps.map(([filename]) => path.join(cache, filename)).join(path.delimiter);
const sourceRevision=option('--source-sha');
if(sourceRevision&&!/^[0-9a-f]{64}$/.test(sourceRevision))throw new Error('--source-sha must be a recorded 64-character SHA-256');
const sourceDir = sourceRevision ? path.join(bridge,'source-snapshots',sourceRevision) : path.join(bridge, 'src', 'main', 'java', 'dev', 'mct', 'bridge');
const javaSources = (await fs.readdir(sourceDir)).filter(n => n.endsWith('.java')).sort().map(n => path.join(sourceDir, n));
const sourceHash = crypto.createHash('sha256'); for (const source of javaSources) sourceHash.update(await fs.readFile(source));
const sourceSha256 = sourceHash.digest('hex');
if(sourceRevision&&sourceRevision!==sourceSha256)throw new Error('Recorded source snapshot contents failed SHA-256 verification');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const rows = [];
const errors = [];
for (const target of targets) {
  const start = Date.now();
  try {
    const dir = path.join(build, target.id); await fs.mkdir(dir, { recursive: true });
    const classes = path.join(dir, 'classes'); await fs.mkdir(classes, { recursive: true });
    const meta = JSON.parse((await download(target.url, path.join(cache, `${target.id}.json`), target.sha1)).toString());
    const major = meta.javaVersion?.majorVersion ?? 17;
    const legacy = target.id.startsWith('1.');
    let mappings = [], targetClass, tickMethod, renderMethod, closeMethod, yarnVersion = null;
    if (legacy) {
      const mappingVersion = yarn.find(v => v.gameVersion === target.id);
      if (!mappingVersion) throw new Error(`No Yarn mappings for ${target.id}; cannot build verified mixin targets`);
      yarnVersion = mappingVersion.version;
      const jar = path.join(cache, `yarn-${encodeURIComponent(yarnVersion)}.jar`);
      await download(`https://maven.fabricmc.net/net/fabricmc/yarn/${encodeURIComponent(yarnVersion)}/yarn-${encodeURIComponent(yarnVersion)}-v2.jar`, jar);
      await exec(tool('jar'), ['xf', jar, 'mappings/mappings.tiny'], { cwd: dir });
      let current;
      // Retain member names actually used by the bridge, including all alias spellings.
      const sourceText = (await Promise.all(javaSources.map(source=>fs.readFile(source,'utf8')))).join('\n');
      const memberNames = new Set([...sourceText.matchAll(/"([^"\n]+)"/g)].flatMap(m => m[1].split('|')));
      for (const line of (await fs.readFile(path.join(dir, 'mappings', 'mappings.tiny'), 'utf8')).split(/\r?\n/)) {
        const cells = line.split('\t');
        if (cells[0] === 'c') { current = { intermediary: cells[1], name: cells[2], methods: [], fields: [] }; mappings.push(current); }
        else if (cells[0] === '' && (cells[1] === 'm' || cells[1] === 'f') && current && (memberNames.has(cells[4]) || ['tick', 'render'].includes(cells[4]))) current[cells[1] === 'm' ? 'methods' : 'fields'].push({ descriptor: cells[2], intermediary: cells[3], name: cells[4] });
      }
      const mc = mappings.find(c => c.name === 'net/minecraft/client/MinecraftClient');
      if (!mc) throw new Error('MinecraftClient mapping missing');
      targetClass = mc.intermediary.replaceAll('/', '.');
      const tick = mc.methods.find(m => m.name === 'tick' && m.descriptor === '()V');
      const render = mc.methods.find(m => m.name === 'render' && m.descriptor === '(Z)V');
      if (!tick || !render) throw new Error('Exact tick/render mapping missing');
      const close = mc.methods.find(m => m.name === 'close' && m.descriptor === '()V');
      // AutoCloseable.close is deliberately absent from Yarn: its Java-interface name is not obfuscated.
      if (!close) {
        const official = meta.downloads.client_mappings;
        if (!official) throw new Error('Official mappings required to verify AutoCloseable.close');
        const text = (await download(official.url, path.join(cache, `${target.id}-client-mappings.txt`), official.sha1)).toString();
        const section = text.split(/^net\.minecraft\.client\.Minecraft -> /m)[1]?.split(/^[^ #\t].* -> .*:$/m)[0];
        if (!section || !section.includes('void close() -> close')) throw new Error('Exact AutoCloseable.close signature missing');
      }
      tickMethod = tick.intermediary + tick.descriptor; renderMethod = render.intermediary + render.descriptor; closeMethod = close ? close.intermediary + close.descriptor : 'close()V';
    } else {
      // Mojang ships unobfuscated classes from 26.1. Verify hook signatures in each actual client jar.
      const jar = path.join(cache, `minecraft-${target.id}.jar`);
      await download(meta.downloads.client.url, jar, meta.downloads.client.sha1);
      const { stdout } = await exec(tool('javap'), ['-private', '-classpath', jar, 'net.minecraft.client.Minecraft'], { maxBuffer: 4 * 1024 * 1024 });
      if (!stdout.includes('void tick();')) throw new Error('Unrecognized Minecraft tick signature');
      targetClass = 'net.minecraft.client.Minecraft'; tickMethod = 'tick()V'; closeMethod = 'close()V';
      if (stdout.includes('void renderFrame(boolean);')) renderMethod = 'renderFrame(Z)V';
      else if (stdout.includes('void runTick(boolean);')) renderMethod = 'runTick(Z)V';
      else throw new Error('Unrecognized natural render entrypoint');
      await fs.writeFile(path.join(dir, 'minecraft-api.txt'), stdout);
    }
    await fs.writeFile(path.join(classes, 'mct-api.json'), JSON.stringify(mappings));
    await fs.writeFile(path.join(classes, 'fabric.mod.json'), JSON.stringify({ schemaVersion: 1, id: 'mct_bridge', version: '0.1.0', name: 'Minecraft AI Tools Companion', environment: 'client', entrypoints: { client: ['dev.mct.bridge.BridgeMod'] }, mixins: ['mct.mixins.json'], depends: { fabricloader: `>=${loaderVersion}`, minecraft: target.id, java: `>=${major}` }, description: 'Authenticated loopback observation and input bridge for mct. Exact-version build; runtime compatibility is verified separately.' }, null, 2));
    await fs.writeFile(path.join(classes, 'mct.mixins.json'), JSON.stringify({ required: true, package: 'dev.mct.bridge.mixin', compatibilityLevel: 'JAVA_' + major, client: ['ClientMixin'], injectors: { defaultRequire: 1 } }, null, 2));
    const mixin = path.join(dir, 'ClientMixin.java');
    await fs.writeFile(mixin, `package dev.mct.bridge.mixin;\nimport org.spongepowered.asm.mixin.Mixin;\nimport org.spongepowered.asm.mixin.injection.At;\nimport org.spongepowered.asm.mixin.injection.Inject;\nimport org.spongepowered.asm.mixin.injection.callback.CallbackInfo;\nimport dev.mct.bridge.BridgeMod;\n@Mixin(targets="${targetClass}",remap=false)\npublic abstract class ClientMixin {\n @Inject(method="${tickMethod}",at=@At("TAIL"),remap=false) private void mctTick(CallbackInfo ci) { BridgeMod.onTick(this); }\n @Inject(method="${renderMethod}",at=@At("TAIL"),remap=false) private void mctFrame(boolean tick, CallbackInfo ci) { BridgeMod.onFrame(this); }\n @Inject(method="${closeMethod}",at=@At("HEAD"),remap=false) private void mctClose(CallbackInfo ci) { BridgeMod.onClose(); }\n}\n`);
    await exec(tool('javac'), ['--release', String(major), '-encoding', 'UTF-8', '-proc:none', '-cp', classpath, '-d', classes, ...javaSources, mixin], { maxBuffer: 4 * 1024 * 1024 });
    const jar = path.join(artifacts, `mct-bridge-${target.id}.jar`);
    await exec(tool('jar'), ['--create', '--file', jar, '-C', classes, '.']);
    const contents = (await exec(tool('jar'), ['tf', jar])).stdout;
    if (!contents.includes('dev/mct/bridge/mixin/ClientMixin.class') || !contents.includes('fabric.mod.json')) throw new Error('Assembled jar is incomplete');
    const row = { version: target.id, java: major, loader: loaderVersion, yarn: yarnVersion, sourceSha256, artifact: path.relative(root, jar).replaceAll('\\', '/'), sha256: sha256(await fs.readFile(jar)), hookTarget: targetClass, tickMethod, renderMethod, closeMethod, compiled: true, hookSignaturesVerified: true, runtimeVerified: false, runtimeScenarios: { connect: 'not-run', observe: 'not-run', move: 'not-run', command: 'not-run', interact: 'not-run', capture: 'not-run', cancel: 'not-run' }, builtAt: new Date().toISOString() };
    rows.push(row); console.log(`${target.id}: compiled Java ${major}, exact hooks checked (${Date.now() - start} ms); runtime not tested`);
  } catch (error) { errors.push({ version: target.id, error: String(error.stack ?? error) }); console.error(`${target.id}: BUILD FAILED: ${error}`); }
}
let previous = [];
try { const prior=JSON.parse(await fs.readFile(path.join(bridge, 'compatibility.json'), 'utf8')); previous=(prior.versions??[]).map(row=>({...row,sourceSha256:row.sourceSha256??prior.sourceSha256})); } catch {}
const combined = [...previous.filter(v => !targets.some(t => t.id === v.version)), ...rows].sort((a, b) => all.findIndex(v => v.id === a.version) - all.findIndex(v => v.id === b.version));
await fs.writeFile(path.join(bridge, 'compatibility.json'), JSON.stringify({ generatedAt: new Date().toISOString(), sourceSha256, minecraftManifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', interpretation: 'each version records its own compile source hash; compiled and hook-signature-checked does not mean launched or runtime verified; no runtime support claim until scenarios pass', versions: combined, buildErrors: errors }, null, 2) + '\n');
if (errors.length) process.exitCode = 1;
