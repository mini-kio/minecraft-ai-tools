import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(project, 'work', 'blockbench-qa');
await fs.mkdir(root, { recursive: true });
const version = process.env.MCT_BLOCKBENCH_VERSION || '4.12.6';
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid Blockbench version');
const response = await fetch(`https://api.github.com/repos/JannisX11/blockbench/releases/tags/v${version}`, { headers: { 'User-Agent': 'minecraft-ai-tools-runtime-qa' }, signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Official release API returned HTTP ${response.status}`);
const release = await response.json();
const name = `Blockbench_${version}_portable.exe`;
const asset = release.assets.find(a => a.name === name);
if (!asset?.digest?.startsWith('sha256:') || !asset.browser_download_url.startsWith(`https://github.com/JannisX11/blockbench/releases/download/v${version}/`)) throw new Error('Official archive or SHA256 digest unavailable');
const archive = path.join(root, name);
let bytes = await fs.readFile(archive).catch(() => null);
if (!bytes) {
  const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(180000) });
  if (!download.ok) throw new Error(`Official archive download returned HTTP ${download.status}`);
  bytes = Buffer.from(await download.arrayBuffer());
}
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
if (`sha256:${digest}` !== asset.digest || bytes.length !== asset.size) throw new Error('Official Blockbench download integrity check failed');
await fs.writeFile(archive, bytes);
const provenance = { version, asset: name, url: asset.browser_download_url, sha256: digest, size: bytes.length, fetchedAt: new Date().toISOString(), release: release.html_url, executable: archive, isolation: path.join(root, `userData-${version}`) };
await fs.writeFile(path.join(root, 'download.json'), JSON.stringify(provenance, null, 2));
console.log(JSON.stringify(provenance));
