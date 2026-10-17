import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'work', 'paper-qa', 'runtimes');
await fs.mkdir(root, { recursive: true });
const run = promisify(execFile), output = {};
for (const major of [17, 21]) {
  const api = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`;
  const response = await fetch(api, { signal: AbortSignal.timeout(30000) }); if (!response.ok) throw new Error(`Official Adoptium API HTTP ${response.status}`);
  const assets = await response.json(); const asset = assets[0]; const pkg = asset.binary.package;
  if (!pkg.link.startsWith(`https://github.com/adoptium/temurin${major}-binaries/`) || !/^[a-f0-9]{64}$/.test(pkg.checksum)) throw new Error('Unexpected runtime provenance');
  const directory = path.join(root, String(major)); await fs.mkdir(directory, { recursive: true });
  const archive = path.join(directory, pkg.name);
  let bytes = await fs.readFile(archive).catch(() => undefined);
  if (!bytes) { const downloaded = await fetch(pkg.link, { signal: AbortSignal.timeout(180000) }); if (!downloaded.ok) throw new Error(`Runtime download HTTP ${downloaded.status}`); bytes = Buffer.from(await downloaded.arrayBuffer()); }
  const sha256 = createHash('sha256').update(bytes).digest('hex'); if (sha256 !== pkg.checksum || bytes.length !== pkg.size) throw new Error('Runtime archive integrity failure');
  await fs.writeFile(archive, bytes);
  let folders = (await fs.readdir(directory, { withFileTypes: true })).filter(d => d.isDirectory());
  if (!folders.length) {
    await run('tar.exe', ['-xf', archive, '-C', directory], { windowsHide: true });
    folders = (await fs.readdir(directory, { withFileTypes: true })).filter(d => d.isDirectory());
  }
  const java = path.join(directory, folders[0].name, 'bin', 'java.exe'); await fs.access(java);
  const version = await run(java, ['-version'], { windowsHide: true });
  output[major] = { java, api, url: pkg.link, sha256, version: version.stderr.trim() };
}
const java25 = path.resolve('work/fabric-tools/jdk25/jdk-25.0.4.1+1/bin/java.exe'); await fs.access(java25); output[25] = { java: java25, source: 'previous verified Fabric runtime preparation' };
await fs.writeFile(path.join(root, 'runtimes.json'), JSON.stringify(output, null, 2)); console.log(JSON.stringify(output, null, 2));
