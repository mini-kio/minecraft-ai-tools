import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import { BridgeService } from '../dist/bridges.js';
import { ModelService } from '../dist/models.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(project, 'work', 'blockbench-qa');
const download = JSON.parse(await fs.readFile(path.join(root, 'download.json'), 'utf8'));
const runDir = path.join(root, `run-${Date.now()}`); await fs.mkdir(runDir, { recursive: true });
const stateDir = path.join(runDir, 'state'), artifactDir = path.join(runDir, 'captures'), userData = path.join(runDir, 'userData');
await Promise.all([stateDir, artifactDir, userData].map(p => fs.mkdir(p, { recursive: true })));
const digest = b => createHash('sha256').update(b).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (condition, message) => { if (!condition) throw new Error(message); };
async function freePort() { const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const port = server.address().port; await new Promise(r => server.close(r)); return port; }

const texture = new PNG({ width: 16, height: 16 });
for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const i = (y * 16 + x) * 4; texture.data.set(((x >> 2) + (y >> 2)) % 2 ? [230, 50, 35, 255] : [35, 180, 220, 255], i); }
const textureUrl = `data:image/png;base64,${PNG.sync.write(texture).toString('base64')}`;
const texturePath=path.join(runDir,'qa_checker.png');await fs.writeFile(texturePath,PNG.sync.write(texture));
const cube = randomUUID(), bone = randomUUID(), tex = randomUUID(), clip = randomUUID();
let fixture = {
  meta: { format_version: '4.12', model_format: 'bedrock', box_uv: false }, name: 'MCT QA animated cube', model_identifier: 'mct_qa', visible_box: [4, 4, 1], resolution: { width: 16, height: 16 },
  elements: [{ name: 'qa_cube', uuid: cube, type: 'cube', from: [-4, 0, -2], to: [4, 10, 2], origin: [0, 0, 0], rotation: [0, 0, 0], box_uv: false, faces: Object.fromEntries(['north', 'south', 'east', 'west', 'up', 'down'].map(side => [side, { uv: [0, 0, 16, 16], texture: 0 }])) }],
  outliner: [{ name: 'qa_bone', uuid: bone, origin: [0, 0, 0], rotation: [0, 0, 0], children: [cube] }],
  textures: [{ name: 'qa_checker.png', uuid: tex, id: '0', width: 16, height: 16, uv_width: 16, uv_height: 16, relative_path:'qa_checker.png', mode: 'bitmap' }],
  animations: [{ uuid: clip, name: 'qa_turn', loop: 'loop', length: 3, snapping: 24, animators: { [bone]: { name: 'qa_bone', type: 'bone', keyframes: [0, 0.5, 1].map((time, index) => ({ uuid: randomUUID(), channel: 'rotation', time, interpolation: 'linear', color: -1, data_points: [{ x: '0', y: String(index * 90), z: '0' }] })) } } }],
};
const fixturePath = path.join(runDir, 'fixture.bbmodel'); await fs.writeFile(fixturePath, JSON.stringify(fixture, null, 2));
let beforeHash = digest(await fs.readFile(fixturePath));
const evidence = { version: download.version, startedAt: new Date().toISOString(), runDir, download, checks: {}, operations: [], console: [] };
const bridge = new BridgeService({ stateDir, artifactDir }); const models = new ModelService(bridge);
const token = randomUUID(); const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(r => ws.on('listening', r)); const wsPort = ws.address().port;
ws.on('connection', socket => socket.once('message', bytes => {
  const hello = JSON.parse(String(bytes)); if (hello.token !== token || hello.kind !== 'blockbench') { socket.close(); return; }
  const peer = bridge.register(socket, hello); socket.send(JSON.stringify({ type: 'registered', id: peer.id, protocol: 1 }));
}));
await fs.writeFile(path.join(stateDir, 'bridge-config.json'), JSON.stringify({ endpoint: `ws://127.0.0.1:${wsPort}`, token, protocol: 1 }));
const cdpPort = await freePort(); let app, browser, page, stage = 'app-startup';
const currentFormat = download.version.startsWith('5.');
async function ownedMainPid() {
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "Name=\'Blockbench.exe\'" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'], { windowsHide: true });
  const records = JSON.parse(stdout || '[]');
  return (Array.isArray(records) ? records : [records]).find(p => p.CommandLine?.includes(userData) && !p.CommandLine.includes('--type='))?.ProcessId;
}
async function operation(action, args = {}) {
  stage = `model.${action}`;
  const value = await models.call(action, args); evidence.operations.push({ action, result: value }); return value;
}
async function imageStats(result) {
  const bytes = await fs.readFile(result.imagePath); const png = PNG.sync.read(bytes); let painted = 0; let colors = new Set();
  for (let i = 0; i < png.data.length; i += 4) if (png.data[i + 3] > 32) { painted++; colors.add(`${png.data[i]},${png.data[i+1]},${png.data[i+2]}`); }
  check(png.width === 640 && png.height === 480, `Expected 640x480, received ${png.width}x${png.height}`);
  check(painted > 1000 && colors.size > 10, 'Capture contains no rendered model');
  return { imagePath: result.imagePath, width: png.width, height: png.height, painted, colors: colors.size, sha256: digest(bytes), animationTime: result.animationTime, camera: result.camera };
}
try {
  // Official desktop executable, isolated profile, no system installation or user
  // app configuration. CDP is used only as this local development test harness.
  app = spawn(download.executable, ['--userData', userData, `--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1', '--disable-gpu', '--enable-unsafe-swiftshader'], { cwd: runDir, windowsHide: true, env: { ...process.env, MCT_STATE_DIR: stateDir } });
  evidence.pid = app.pid; app.stdout.on('data', b => evidence.console.push(String(b))); app.stderr.on('data', b => evidence.console.push(String(b)));
  const bootDeadline = Date.now() + 60000;
  while (!browser && Date.now() < bootDeadline) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); } catch { await sleep(500); } }
  check(browser, 'Official Blockbench desktop did not expose its local test CDP endpoint');
  for (;;) { page = browser.contexts()[0]?.pages().find(p => /index\.html/.test(p.url())); if (page || Date.now() > bootDeadline) break; await sleep(100); }
  check(page, 'Blockbench renderer did not open');
  page.on('pageerror', e => { evidence.console.push(`pageerror [${stage}]: ${e.stack || e.message}`); (evidence.consoleEvents ||= []).push({ stage, at: new Date().toISOString(), message: e.message, stack: e.stack }); });
  page.on('dialog', dialog => { evidence.console.push(`dialog (${dialog.type()}): ${dialog.message()}`); void fs.writeFile(path.join(runDir, 'progress.json'), JSON.stringify({ ...evidence, operations: evidence.operations.slice(-3) }, null, 2)); });
  await page.waitForFunction(() => typeof Blockbench !== 'undefined' && typeof Plugin !== 'undefined' && typeof ModelProject !== 'undefined' && typeof MenuBar !== 'undefined' && document.readyState === 'complete', null, { timeout: 30000 });
  evidence.runtime = await page.evaluate(() => ({ version: Blockbench.version, platform: Blockbench.platform, isApp, globals: { process: typeof process, require: typeof require, Preview: typeof Preview, Animation: typeof Animation, BBPlugin: typeof BBPlugin } }));
  evidence.runtime.mainPid = await ownedMainPid();
  if (process.env.MCT_BLOCKBENCH_BOOT_ONLY === '1') {
    stage = 'vanilla-boot-without-plugin'; await sleep(3000);
    evidence.baseline = await page.evaluate(() => ({ mctLoaded: !!Plugins.registered.mct_bridge, setupSuccessful: Blockbench.setup_successful, resizerReady: typeof Interface.Resizers.start_screen_width?.update === 'function', projects: ModelProject.all.length }));
    throw Object.assign(new Error('Vanilla boot baseline captured without loading MCT'), { code: 'BOOT_BASELINE_DONE' });
  }
  evidence.backgroundRendering = await page.evaluate(() => { settings.background_rendering.set(true); return settings.background_rendering.value; });
  check(evidence.runtime.isApp, 'This is not the actual desktop Blockbench runtime');
  const unrelated = await page.evaluate(() => {
    // Hide only this harness-owned application window. Model rendering is offscreen.
    if (typeof require === 'function') { const window = require('@electron/remote').getCurrentWindow(); window.webContents.setBackgroundThrottling(false); window.hide(); }
    newProject(Formats.free); Project.name = 'MCT QA unrelated project'; return Project.uuid;
  });
  evidence.unrelatedProject = unrelated;
  evidence.nativeFilesystem = 'real CLI filesystem; model and texture data sent over production bridge; no Blockbench filesystem adapter';
  await page.evaluate(config => localStorage.setItem('mct_bridge_config', JSON.stringify(config)), { endpoint: `ws://127.0.0.1:${wsPort}`, token, protocol: 1 });
  const loaded = await page.evaluate(async pluginPath => { const plugin = new Plugin(); await plugin.loadFromFile({ path: pluginPath }, false); return { id: plugin.id, installed: plugin.installed, registered: !!Plugins.registered.mct_bridge }; }, path.join(project, 'bridges', 'blockbench', 'mct_bridge.js'));
  evidence.plugin = loaded;
  const connectedDeadline = Date.now() + 15000;
  while (!bridge.peers.size && Date.now() < connectedDeadline) await sleep(100);
  check(bridge.peers.size === 1, `Plugin did not connect: ${JSON.stringify(loaded)}`); evidence.checks.desktopPluginConnection = true;
  let opened = await operation('open', { path: fixturePath });
  if (currentFormat) {
    fixture = await page.evaluate(() => Codecs.project.compile({ raw: true, backup: true }));
    check(String(fixture.meta.format_version).startsWith('5.'), 'Current Blockbench did not emit a 5.x project format');
    delete fixture.textures[0].source;delete fixture.textures[0].path;fixture.textures[0].relative_path='qa_checker.png';
    await operation('close', { session: opened.id });
    await fs.writeFile(fixturePath, JSON.stringify(fixture, null, 2));
    beforeHash = digest(await fs.readFile(fixturePath));
    opened = await operation('open', { path: fixturePath }); evidence.checks.currentBbmodel5Format = true;
  }
  const session = opened.id; evidence.session = session;
  check(opened.model.elements.length === 1 && opened.model.groups.length === 1, 'Model elements or bone hierarchy were not loaded');
  check(opened.model.elements[0].parent === opened.model.groups[0].uuid && opened.model.groups[0].children.includes(opened.model.elements[0].uuid), 'Bone hierarchy relationships are missing');
  check(opened.model.textures[0].width === 16 && opened.model.textures[0].error === 0, 'Embedded texture did not load');
  check(opened.model.animations.some(a => a.name === 'qa_turn'), 'Animation clip was not loaded'); evidence.checks.openInspectTextureUvBones = true;
  check(opened.fileTransport === 'cli-read-model-data' && opened.changed === false, 'Production file transport or initial fingerprint missing'); evidence.checks.realCliSourceTransport = true;
  const inspected = await operation('inspect', { session }); check(inspected.elements[0].faces.north.uv.length === 4, 'UV metadata missing');
  for (const [action, args, code] of [['animation', { clip: 'missing_clip' }, 'ANIMATION_NOT_FOUND'], ['animation', { clip: 'qa_turn', time: -1 }, 'INVALID_ARGUMENT'], ['camera', { position: { x: 'invalid', y: 1, z: 1 } }, 'INVALID_ARGUMENT']]) {
    let rejected; try { await operation(action, { session, ...args }); } catch (error) { rejected = error.code; }
    check(rejected === code, `${action} did not reject invalid arguments as ${code}`);
  }
  evidence.checks.invalidArgumentsRejected = true;
  await operation('animation', { session, clip: 'qa_turn', time: 0, play: true });
  const playDeadline = Date.now() + 3000; let playingTime = 0;
  while (playingTime <= 0.001 && Date.now() < playDeadline) { await sleep(100); playingTime = await page.evaluate(() => Timeline.time); }
  evidence.playState = await page.evaluate(() => ({ time: Timeline.time, playing: Timeline.playing, animatorOpen: Animator.open, mode: Modes.selected.id, background: settings.background_rendering.value, visibility: document.visibilityState, speed: Timeline.playback_speed, now: performance.now(), lastFrame: Timeline.last_frame_timecode }));
  check(playingTime > 0.001, 'Animation play did not advance the real timeline');
  await operation('animation', { session, clip: 'qa_turn', time: 0, play: false });
  check(await page.evaluate(() => Timeline.playing) === false, 'Animation pause did not stop the timeline');
  evidence.checks.playAndPauseActualTimeline = true;
  await operation('camera', { session, position: { x: 28, y: 22, z: 34 }, target: { x: 0, y: 5, z: 0 } });
  await sleep(300);
  const initial = await imageStats(await operation('capture', { session, width: 640, height: 480, clip: 'qa_turn', time: 0, play: false }));
  await operation('animation', { session, clip: 'qa_turn', time: 0.5, play: false });
  const animated = () => ({ mode: Modes.selected.id, time: Timeline.time, selected: Animation.selected?.name, playing: Animation.all.map(a => ({ name: a.name, playing: a.playing, animators: Object.values(a.animators).map(b => ({ uuid: b.uuid, name: b.name, rotation: b.rotation?.map(k => ({ time: k.time, points: k.data_points.map(p => ({ x: p.x, y: p.y, z: p.z })) })) })) })), bones: Group.all.map(g => ({ name: g.name, rotation: g.mesh?.rotation?.toArray() })), elements: Outliner.elements.map(e => ({ name: e.name, rotation: e.mesh?.rotation?.toArray() })) });
  evidence.animationBeforeCapture = await page.evaluate(animated);
  const half = await imageStats(await operation('capture', { session, width: 640, height: 480, clip: 'qa_turn', time: 0.5, play: false }));
  evidence.animationAfterCapture = await page.evaluate(animated);
  evidence.initial = initial; evidence.half = half;
  check(initial.sha256 !== half.sha256, 'Animation time changes produced identical pixels'); check(half.animationTime === 0.5, 'Animation time was not preserved'); evidence.checks.animationTimeChangesRenderedPixels = true;
  await operation('camera', { session, position: { x: -28, y: 12, z: 20 }, target: { x: 0, y: 5, z: 0 } });
  const camera = await imageStats(await operation('capture', { session, width: 640, height: 480, clip: 'qa_turn', time: 0, play: false }));
  check(camera.sha256 !== initial.sha256, 'Camera change did not change rendered pixels'); evidence.checks.cameraChangesRenderedPixels = true; evidence.camera = camera;
  const frames = await operation('sample', { session, clip: 'qa_turn', frames: 3, from: 0, to: 0.5, width: 640, height: 480 });
  check(frames.captures.length === 3 && frames.captures[2].animationTime === 0.5, 'Animation sample timeline is incorrect'); evidence.checks.animationFrameSequence = true;
  for(let i=0;i<texture.data.length;i+=4){texture.data[i]=30;texture.data[i+1]=240;texture.data[i+2]=60;}await fs.writeFile(texturePath,PNG.sync.write(texture));
  const dirtyTexture=await operation('inspect',{session});check(dirtyTexture.changed&&dirtyTexture.changedFiles.includes(texturePath),'External texture edit was not detected');evidence.checks.externalTextureChangeDetected=true;
  const textureReload=await operation('reload',{session});opened.project=textureReload.project;check(textureReload.changed===false,'Texture reload baseline was not reset');
  const textureCapture=await imageStats(await operation('capture',{session,width:640,height:480,clip:'qa_turn',time:0,play:false}));check(textureCapture.camera.position.every((n,i)=>Math.abs(n-camera.camera.position[i])<1e-5)&&textureCapture.camera.target.every((n,i)=>Math.abs(n-camera.camera.target[i])<1e-5),'Reload changed the comparison camera');check(textureCapture.sha256!==camera.sha256,'Texture reload did not change actual pixels');evidence.externalTexture=textureCapture;evidence.checks.externalTextureReloadChangesPixels=true;
  check(digest(await fs.readFile(fixturePath)) === beforeHash, 'Observation changed the original .bbmodel bytes'); evidence.checks.originalUnchangedByObservation = true;
  const valid = await fs.readFile(fixturePath, 'utf8'); await fs.writeFile(fixturePath, '{broken JSON');
  check((await operation('inspect', { session })).changed === true, 'External malformed source edit was not detected'); evidence.checks.externalSourceChangeDetected = true;
  let rejectedReload = false; try { await operation('reload', { session }); } catch { rejectedReload = true; }
  check(rejectedReload && (await operation('inspect', { session })).project === opened.project, 'Malformed reload closed the last working project');
  evidence.checks.malformedReloadPreservesWorkingProject = true;
  fixture.elements[0].to[1] = 14; await fs.writeFile(fixturePath, JSON.stringify(fixture, null, 2)); const modifiedHash = digest(await fs.readFile(fixturePath));
  const reloaded = await operation('reload', { session });
  check(reloaded.elements[0].to[1] === 14 && reloaded.project !== opened.project, 'Reload did not open updated source in a new owned project');
  check(reloaded.changed === false, 'Reload did not reset source fingerprint');
  check(digest(await fs.readFile(fixturePath)) === modifiedHash, 'Reload wrote to source model'); evidence.checks.reloadSeesExternalChanges = true;
  await operation('close', { session });
  const survivors = await page.evaluate(() => ModelProject.all.map(p => p.uuid));
  check(survivors.includes(unrelated) && !survivors.includes(reloaded.project), 'Close touched an unrelated project or left its owned project open'); evidence.checks.closePreservesOtherProjects = true;
  evidence.status = 'passed';
} catch (error) { if (error.code === 'BOOT_BASELINE_DONE') evidence.status = 'baseline-complete'; else { evidence.status = 'failed'; evidence.error = { message: error.message, stack: error.stack }; process.exitCode = 1; } }
finally {
  if (page && !page.isClosed()) { try { await Promise.race([page.evaluate(async () => { Plugins.registered.mct_bridge?.unload(); for (const project of ModelProject.all.slice()) await project.close(true); require('@electron/remote').app.quit(); }), sleep(3000)]); } catch {} }
  await models.close(); await bridge.close(); for (const socket of ws.clients) socket.terminate(); await new Promise(r => ws.close(r));
  const mainPid = evidence.runtime?.mainPid ?? await ownedMainPid().catch(() => undefined);
  if (mainPid) { try { process.kill(mainPid); } catch {} }
  await Promise.race([browser?.close().catch(() => {}), sleep(3000)]);
  if (app && app.exitCode === null) { await Promise.race([new Promise(r => app.once('exit', r)), sleep(3000)]); if (app.exitCode === null) app.kill(); }
  evidence.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(runDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await fs.writeFile(path.join(root, 'latest.json'), JSON.stringify({ status: evidence.status, version: download.version, evidencePath: path.join(runDir, 'evidence.json'), checks: evidence.checks, error: evidence.error }, null, 2));
  console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks, error: evidence.error?.message, evidencePath: path.join(runDir, 'evidence.json') }));
}
