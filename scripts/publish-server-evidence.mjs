import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'), output=path.join(root,'docs/evidence/servers');
const source=JSON.parse(await fs.readFile(path.join(root,'work/paper-qa/results.json'),'utf8'));
const artifacts=JSON.parse(await fs.readFile(path.join(root,'bridges/fabric/compatibility.json'),'utf8'));
if(source.versions.length!==24)throw new Error('Expected the full current 24-release target matrix');
for(const row of source.versions){
  if(row.status==='unavailable')continue;
  if(row.status!=='passed'||!row.runtimeVerified||Object.values(row.scenarios).some(v=>v!=='pass'))throw new Error('Incomplete Paper runtime proof: '+row.version);
  if(row.backend==='fabric'&&row.artifactSha256!==artifacts.versions.find(v=>v.version===row.version)?.sha256)throw new Error('Stale Fabric artifact in Paper proof: '+row.version);
}
await fs.mkdir(path.join(output,'paper'),{recursive:true});await fs.mkdir(path.join(output,'cancellation'),{recursive:true});
const hashes=[];
async function publish(file,bytes){const target=path.join(output,file);await fs.writeFile(target,bytes);hashes.push({file:file.replaceAll('\\','/'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}
for(const row of source.versions){
  await publish(`paper/${row.version}.json`,Buffer.from(JSON.stringify(row,null,2)));
  if(row.capture?.imagePath){const png=await fs.readFile(row.capture.imagePath);if(png.length>2*1024*1024)throw new Error('Representative capture exceeds portable evidence limit');await publish(`paper/${row.version}.png`,png);}
  if(row.runtimeVerified){
    await publish(`paper/${row.version}-observe.json`,await fs.readFile(path.join(root,'work/paper-qa',row.version,'observation.json')));
    await publish(`paper/${row.version}-chest.json`,await fs.readFile(path.join(root,'work/paper-qa',row.version,'chest.json')));
    if(row.backend==='fabric')await publish(`paper/${row.version}-chest.png`,await fs.readFile(path.join(root,'work/paper-qa',row.version,'chest-screen.png')));
  }
}
await publish('paper/matrix.json',Buffer.from(JSON.stringify(source,null,2)));
for(const [name,subdir]of[['server-start','server-cancellation-live'],['player','player-cancellation-live']]){
  const evidence=JSON.parse(await fs.readFile(path.join(root,'work',subdir,'evidence.json'),'utf8'));if(evidence.status!=='passed')throw new Error('Cancellation proof failed: '+name);
  await publish(`cancellation/${name}.json`,Buffer.from(JSON.stringify(evidence,null,2)));
  if(evidence.recoveryCapture?.imagePath)await publish(`cancellation/${name}-recovery.png`,await fs.readFile(evidence.recoveryCapture.imagePath));
}
const passed=source.versions.filter(v=>v.runtimeVerified),native=passed.filter(v=>v.backend==='fabric'),bots=passed.filter(v=>v.backend==='mineflayer'),unavailable=source.versions.filter(v=>v.status==='unavailable');
const lines=['# Server verification evidence','',`Generated ${new Date().toISOString()}. ${passed.length} exact STABLE Paper releases passed seven actual scenarios; ${unavailable.length} exact releases have no official STABLE build.`,
'','The seven scenarios are connection, observation/inventory, measured movement, player-command result, chest GUI interaction, capture and stopped movement after cancellation.',
'',`${native.length} versions use the actual Fabric Minecraft renderer with the recorded matching bridge SHA256, native HUD and a hotbar selection assertion. ${bots.length} versions use Mineflayer with an explicitly approximate Prismarine capture; these do not prove native HUD, resource packs or exact game rendering. No protocol or server-version fallback is used.`,
'','Paper builds and checksums come from the [official Fill API](https://fill.papermc.io/v3/projects/paper). [matrix.json](paper/matrix.json) contains raw per-version results; absolute paths refer to the original isolated QA run and are retained as provenance. The adjacent PNG files are portable copies.',
'','| Game release | Exact Paper build | Backend | Result | Evidence |','|---|---:|---|---|---|',...source.versions.map(v=>`| ${v.version} | ${v.paper?.build??'unavailable'} | ${v.backend??'—'} | ${v.status} | [JSON](paper/${v.version}.json)${v.capture?.imagePath?` · [PNG](paper/${v.version}.png) · [Observation](paper/${v.version}-observe.json) · [Chest](paper/${v.version}-chest.json)${v.backend==='fabric'?` · [Chest PNG](paper/${v.version}-chest.png)`:''}`:''} |`),
'','[Actual Java startup cancellation](cancellation/server-start.json) verifies that the owned PID has exited before CANCELLED returns. [Actual player cancellation](cancellation/player.json) verifies early connect cleanup, released movement, capture cleanup and reuse, and disconnected pending container interaction.',
'','Every included JSON/PNG file has byte size and SHA256 in [sha256.json](sha256.json). No discovery records, bridge tokens, account credentials, user configuration or native host permissions are included.',''];
await publish('README.md',Buffer.from(lines.join('\n')));await fs.writeFile(path.join(output,'sha256.json'),JSON.stringify({generatedAt:new Date().toISOString(),files:hashes},null,2));
console.log(JSON.stringify({output,passed:passed.length,native:native.length,bots:bots.length,unavailable:unavailable.length,bytes:hashes.reduce((n,f)=>n+f.bytes,0)}));
