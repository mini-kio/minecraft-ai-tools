import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ServerService } from '../dist/servers/index.js';
if (!process.argv.includes('--accept-eula')) throw new Error('Pass --accept-eula for isolated server cancellation QA');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.join(root, 'work', 'server-cancellation-live'); await fs.mkdir(directory, { recursive: true });
const runtimes = JSON.parse(await fs.readFile(path.join(root, 'work/paper-qa/runtimes/runtimes.json'), 'utf8'));
const servers = new ServerService({ stateDir: directory, artifactDir: directory });
const evidence = { startedAt: new Date().toISOString(), checks: {}, version: '1.21.4' };
try {
  let created = (await servers.call('list')).sessions.find(s => s.version === '1.21.4' && s.software === 'vanilla');
  created ||= await servers.call('create', { version: '1.21.4', acceptEula: true });
  evidence.session = created.sessionId;
  const controller = new AbortController(); let observation;
  const begin = Date.now();
  try {
    await servers.call('start', { session: created.sessionId, javaPath: runtimes[21].java, signal: controller.signal, onProgress(phase) { if (phase === 'starting') { observation = servers.call('observe', { session: created.sessionId }); controller.abort(); } } });
    throw new Error('Interrupted startup incorrectly returned success');
  } catch(error) { if (error.code !== 'CANCELLED') throw error; evidence.code = error.code; }
  evidence.elapsedMs = Date.now() - begin; evidence.duringStart = await observation;
  evidence.after = await servers.call('observe', { session: created.sessionId });
  if (!evidence.duringStart.pid) throw new Error('No actual Java process was started');
  let alive = true; try { process.kill(evidence.duringStart.pid, 0); } catch { alive = false; }
  if (alive || evidence.after.pid || !['stopped','failed'].includes(evidence.after.state)) throw new Error('Startup cancellation returned before its owned process exited');
  evidence.checks.actualJavaProcessStarted = true; evidence.checks.cancelledStartupWaitedForExit = true;
  evidence.checks.sessionRemainsObservable = true; evidence.status = 'passed';
} catch(error) { evidence.status = 'failed'; evidence.error = { code: error.code, message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { await servers.close(); evidence.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence,null,2)); console.log(JSON.stringify(evidence)); }
