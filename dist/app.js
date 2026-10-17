import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fail } from './contracts.js';
import { BridgeService } from './bridges.js';
import { ModelService } from './models.js';
import { JobManager } from './jobs.js';
import { MapService } from './maps/index.js';
import { PlayerService } from './players/index.js';
import { ServerService, releaseTargets, discoverJava } from './servers/index.js';
import { captureViewer } from './viewer.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from 'node:net';
import { inspectNative } from './native-interior.js';
import { NativeNavigation } from './native-navigation.js';
import { ResourceManager } from './resources.js';
import { prepareMapStage, applyMapStage, verifyStageSources } from './maps/staging.js';
import { loadInspection } from './interior/index.js';
import { exportCollisionData } from './collision-export.js';
import { registerCollisionDirectory } from './maps/native-collisions.js';
const require = createRequire(import.meta.url);
export class Application {
    options;
    bridges;
    models;
    maps;
    players;
    servers;
    jobs = new JobManager();
    viewerUrl = (_session, _args = {}) => '';
    nativeViewerUrl = (_session) => '';
    nativeFrames = new Map();
    async nativeFrame(session) {
        const native = this.nativeMaps.get(session);
        if (!native)
            fail('SESSION_NOT_FOUND', 'Stage this map with a Fabric client before opening its live game view');
        const pending = this.nativeFrames.get(session);
        if (pending)
            return pending;
        const capture = (async () => { const result = await this.bridges.request(native.client, 'capture', {}); const file = path.resolve(result.imagePath), root = path.resolve(this.options.artifactDir); if (!file.startsWith(root + path.sep))
            fail('INVALID_CAPTURE', 'Capture must be inside the artifact directory'); try {
            return await fs.readFile(file);
        }
        finally {
            await fs.unlink(file).catch(() => { });
        } })();
        this.nativeFrames.set(session, capture);
        try {
            return await capture;
        }
        finally {
            this.nativeFrames.delete(session);
        }
    }
    nativeMaps = new Map();
    navigation;
    resources;
    mapResources = new Map();
    constructor(options) {
        this.options = options;
        registerCollisionDirectory(path.join(options.stateDir, 'collision-data'));
        this.bridges = new BridgeService(options);
        this.models = new ModelService(this.bridges);
        this.maps = new MapService(options);
        this.players = new PlayerService(options);
        this.servers = new ServerService(options);
        this.navigation = new NativeNavigation(this.bridges, options.artifactDir);
        this.resources = new ResourceManager(options.stateDir);
    }
    async viewerData(args) {
        const data = await this.maps.call('viewer-data', args), config = { ...this.mapResources.get(args.session), ...args };
        if (config.textures !== false)
            data.resourcePreview = await this.resources.prepare(data, config);
        return data;
    }
    async execute(domain, action, args = {}) {
        if (args.signal?.aborted && action !== 'stop')
            fail('CANCELLED', 'Operation was cancelled');
        if (args.async && domain !== 'job') {
            const controller = new AbortController();
            const syncArgs = { ...args, async: false, signal: controller.signal };
            const longActions = { map: ['open', 'reload', 'view', 'resources', 'capture', 'slice', 'stage', 'collisions'], model: ['open', 'reload', 'inspect', 'capture', 'sample'], interior: ['check', 'inspect', 'tour'], test: ['create', 'start'], server: ['create', 'start'], player: ['connect', 'move', 'capture', 'viewer', 'interact', 'inventory'], client: ['connect', 'capture'], doctor: ['check'] };
            const cancellable = longActions[domain]?.includes(action);
            const work = async () => { try {
                const result = await this.execute(domain, action, syncArgs);
                if (controller.signal.aborted) {
                    try {
                        if (action === 'open' && domain === 'map')
                            await this.maps.call('close', { session: result.session });
                        if (action === 'stage' && domain === 'map')
                            await this.execute('map', 'close', { session: args.session });
                        if (action === 'open' && domain === 'model')
                            await this.models.call('close', { session: result.id });
                    }
                    catch (cleanup) {
                        fail('CANCELLATION_CLEANUP_FAILED', 'Cancelled operation could not release its session', { cause: cleanup.message });
                    }
                    fail('CANCELLED', 'Operation cancelled after cleanup');
                }
                return result;
            }
            catch (error) {
                if (controller.signal.aborted && error.code !== 'CANCELLATION_CLEANUP_FAILED')
                    fail('CANCELLED', 'Operation cancelled after cleanup');
                throw error;
            } };
            return this.jobs.start(work, cancellable ? async () => { controller.abort(); if (domain === 'interior' && action === 'tour' && args.player)
                return this.execute('player', 'stop', { session: args.player }); if (['player', 'client'].includes(domain) && args.session)
                return this.execute(domain, 'stop', { session: args.session }); if (domain === 'model' && action === 'sample' && args.session)
                return this.models.call('stop', { session: args.session }); } : undefined);
        }
        switch (domain) {
            case 'doctor': return this.doctor(args);
            case 'bridge':
                if (action === 'config') {
                    const config = JSON.parse(await fs.readFile(path.join(this.options.stateDir, 'bridge-config.json'), 'utf8'));
                    return { ...config, pluginPath: path.resolve('bridges/blockbench/mct_bridge.js'), discoveryDirectories: [path.join(this.options.stateDir, 'clients'), '%APPDATA%/.minecraft/.mct'] };
                }
                return this.bridges.call(action, args);
            case 'client':
                if (['stop', 'detach', 'close', 'disconnect'].includes(action))
                    this.navigation.cancel(args.session);
                return this.bridges.call(action, args);
            case 'model': return this.models.call(action, args);
            case 'map': {
                if (action === 'collisions') {
                    const result = await exportCollisionData(this.bridges, path.join(this.options.stateDir, 'collision-data'), args);
                    if (args.session)
                        await this.maps.call('reload', args);
                    return result;
                }
                if (action === 'resources') {
                    await this.maps.call('observe', args);
                    this.mapResources.set(args.session, { ...this.mapResources.get(args.session), ...args });
                    return { session: args.session, ...await this.viewerData(args) };
                }
                if (args.session && ['resourcePack', 'resourcePacks', 'assetsJar', 'textures'].some(key => args[key] !== undefined))
                    this.mapResources.set(args.session, { ...this.mapResources.get(args.session), ...args });
                if (action === 'stage')
                    return this.stageMap(args);
                const native = this.nativeMaps.get(args.session);
                if (native && action === 'close') {
                    await this.bridges.request(native.client, 'disconnect', {}).catch(() => { });
                    await this.servers.call('stop', { session: native.server, force: true });
                    this.nativeMaps.delete(args.session);
                }
                if (native && args.renderer !== 'preview' && ['capture', 'view', 'camera'].includes(action)) {
                    if (action === 'camera')
                        return this.nativeCamera(native, args);
                    const result = await this.bridges.request(native.client, action === 'capture' ? 'capture' : 'observe', { ...args, provenance: native });
                    return { ...result, session: args.session, viewerUrl: this.nativeViewerUrl(args.session), source: 'minecraft-native-renderer', exactGamePixels: true, provenance: native };
                }
                if (action === 'view') {
                    const session = await this.maps.call('observe', args);
                    return { ...session, viewerUrl: this.viewerUrl(args.session, args), source: 'structural-preview', approximate: true };
                }
                if (action === 'capture' && args.mode !== 'slice' && !args.axis && args.mode !== 'isometric') {
                    await this.maps.call('observe', args);
                    return captureViewer(this.viewerUrl(args.session, args), this.options.artifactDir, args);
                }
                const result = await this.maps.call(action, args);
                if (action === 'close')
                    this.mapResources.delete(args.session);
                if (action === 'open')
                    this.mapResources.set(result.session, args);
                return action === 'open' ? { ...result, viewerUrl: this.viewerUrl(result.id || result.session, args), preview: { source: args.textures === false ? 'structural-preview' : 'java-resource-model-preview', approximate: true } } : result;
            }
            case 'interior': {
                if (action === 'tour')
                    return this.interiorTour(args);
                if (!['check', 'inspect'].includes(action))
                    fail('UNKNOWN_ACTION', 'Use interior check or interior tour');
                if (args.client)
                    return inspectNative(this.bridges, args, this.options.artifactDir);
                return this.maps.call('interior-check', args);
            }
            case 'player': return this.player(action, args);
            case 'test':
            case 'server': return this.servers.call(action, { ...args, javaPath: await this.javaPath(args) });
            case 'job': return this.jobs.call(action, args);
            case 'session': return this.sessions(action, args);
            case 'observe':
            case 'capture': return this.bySession(domain, args);
            default: fail('UNKNOWN_DOMAIN', `Unknown command group: ${domain}`);
        }
    }
    async javaPath(args) {
        const explicit = args.javaPath || args.java || process.env.MCT_JAVA;
        if (explicit)
            return explicit;
        const portable = path.resolve('work/fabric-tools/jdk25');
        for (const folder of await fs.readdir(portable).catch(() => [])) {
            const executable = path.join(portable, folder, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
            try {
                if ((await fs.stat(executable)).isFile())
                    return executable;
            }
            catch { }
        }
        return undefined;
    }
    async player(action, args) {
        args = { ...args };
        if (args.position && action === 'move')
            args.target ??= args.position;
        if (args.control)
            args.controls ??= [args.control];
        if (args.command !== undefined)
            args.text ??= args.command;
        if (action === 'connect' && args.host && String(args.host).includes(':')) {
            try {
                const endpoint = new URL(`minecraft://${args.host}`);
                args.host = endpoint.hostname.replace(/^\[|\]$/g, '');
                if (endpoint.port)
                    args.port = Number(endpoint.port);
            }
            catch {
                fail('INVALID_ARGUMENT', 'Use HOST or HOST:PORT for the server address');
            }
        }
        const peerId = args.client || (this.bridges.peers.has(args.session) ? args.session : undefined);
        if (action === 'attach')
            return this.bridges.call('attach', args);
        if (action === 'list')
            return { bots: await this.players.call('list', args), clients: (await this.bridges.call('list', args)).connected.filter((p) => p.kind === 'fabric') };
        if (peerId || args.backend === 'client') {
            const peer = peerId ? this.bridges.peers.get(peerId) : [...this.bridges.peers.values()].find(p => p.kind === 'fabric');
            if (!peer || peer.kind !== 'fabric')
                fail('CLIENT_REQUIRED', 'Attach a matching running Fabric client using mct client attach <discovery.json>');
            if (args.version && peer.version !== args.version)
                fail('VERSION_MISMATCH', 'Connected client has a different game version');
            if (['stop', 'close', 'disconnect'].includes(action))
                this.navigation.cancel(peer.id);
            if (action === 'close')
                return this.bridges.call('detach', { session: peer.id });
            if (action === 'move' && args.target)
                return this.navigation.move(peer.id, args);
            if (action === 'look' && args.target) {
                const observation = await this.bridges.request(peer.id, 'observe', {}), p = observation.player, t = args.target;
                if (!p)
                    fail('NOT_CONNECTED', 'Client must have a loaded player to look at a target');
                if (['x', 'y', 'z'].some(k => !Number.isFinite(t[k])))
                    fail('INVALID_ARGUMENT', 'Target coordinates must be finite');
                const dx = t.x - p.x, dy = t.y - (p.y + 1.62), dz = t.z - p.z;
                return this.bridges.request(peer.id, 'look', { yaw: Math.atan2(-dx, dz), pitch: -Math.atan2(dy, Math.hypot(dx, dz)) });
            }
            if (action === 'interact') {
                const observation = await this.bridges.request(peer.id, 'observe', {}), p = observation.player, block = args.position;
                if (!p)
                    fail('NOT_CONNECTED', 'Client must have a loaded player to interact');
                if (block) {
                    if (['x', 'y', 'z'].some(k => !Number.isFinite(block[k])))
                        fail('INVALID_ARGUMENT', 'Block coordinates must be finite');
                    const target = { x: Math.floor(block.x) + .5, y: Math.floor(block.y) + .5, z: Math.floor(block.z) + .5 };
                    if (Math.hypot(p.x - target.x, p.y + 1.62 - target.y, p.z - target.z) > 5)
                        fail('OUT_OF_REACH', 'Move within interaction reach');
                    await this.player('look', { session: peer.id, target });
                }
                await this.bridges.request(peer.id, 'input', { key: 'use', action: 'press', durationMs: 120 });
                await sleep(180);
                const result = await this.bridges.request(peer.id, 'observe', {});
                if (args.operation === 'open' && !result.screen)
                    fail('INTERACTION_NOT_CONFIRMED', 'Use input did not open a container; inspect the current view before retrying');
                return { ...result, sent: true, interaction: 'native-use', confirmation: 'Inspect screen and block state for the actual result' };
            }
            const mapped = action === 'connect' ? 'connect' : action === 'disconnect' ? 'disconnect' : action === 'move' ? 'input' : action;
            return this.bridges.request(peer.id, mapped, { ...args, key: args.key || args.control || 'forward', durationMs: args.durationMs || args.duration || 500, server: args.server || args.host });
        }
        if (action === 'connect' && (args.backend || 'auto') === 'auto') {
            try {
                return await this.players.call('connect', args);
            }
            catch (error) {
                if (error.code !== 'CLIENT_REQUIRED' && error.code !== 'UNSUPPORTED_VERSION')
                    throw error;
                const peer = [...this.bridges.peers.values()].find(p => p.kind === 'fabric' && (!args.version || p.version === args.version));
                if (!peer)
                    throw error;
                return this.player(action, { ...args, client: peer.id });
            }
        }
        return this.players.call(action, args);
    }
    async sessions(action, args) {
        if (action === 'list')
            return { maps: await this.maps.call('list', {}), models: await this.models.call('list', {}), players: await this.player('list', {}), servers: await this.servers.call('list', {}) };
        if (action === 'close')
            return this.bySession('close', args);
        return this.bySession('observe', args);
    }
    async bySession(action, args) {
        const sid = String(args.session || '');
        if (sid.startsWith('map'))
            return this.execute('map', action, args);
        if (sid.startsWith('model'))
            return this.models.call(action, args);
        if (this.bridges.peers.has(sid))
            return this.bridges.call(action, args);
        if (sid.startsWith('server') || sid.startsWith('test') || sid.startsWith('rcon'))
            return this.servers.call(action === 'close' ? 'stop' : action, args);
        return this.player(action, args);
    }
    async stageMap(args) {
        const map = await this.maps.call('observe', args);
        const peer = this.bridges.peers.get(args.client);
        if (!peer || peer.kind !== 'fabric')
            fail('CLIENT_REQUIRED', 'Pass --client ID for a matching attached Fabric client');
        if (!map.version || peer.version !== map.version)
            fail('VERSION_MISMATCH', 'World and client must have the same exact Minecraft version', { world: map.version, client: peer.version });
        const before = await this.bridges.request(peer.id, 'observe', {});
        if (before.connected)
            fail('CLIENT_BUSY', 'Disconnect the client before loading a staged world');
        const viewDistance = args.viewDistance ?? 12;
        if (!Number.isInteger(viewDistance) || viewDistance < 2 || viewDistance > 32)
            fail('INVALID_ARGUMENT', 'viewDistance must be an integer from 2 to 32');
        let plan;
        if (args.maxVolume !== undefined && (!Number.isSafeInteger(args.maxVolume) || args.maxVolume < 1 || args.maxVolume > 8_000_000))
            fail('INVALID_ARGUMENT', 'maxVolume must be an integer from 1 to 8000000');
        if (args.maxCommands !== undefined && (!Number.isSafeInteger(args.maxCommands) || args.maxCommands < 1 || args.maxCommands > 200_000))
            fail('INVALID_ARGUMENT', 'maxCommands must be an integer from 1 to 200000');
        if (!(await fs.stat(map.path)).isDirectory())
            plan = await prepareMapStage(map.path, { version: map.version, dimension: map.dimension, bounds: args.bounds, workDir: path.join(this.options.stateDir, 'map-stages'), signal: args.signal, maxVolume: args.maxVolume, maxCommands: args.maxCommands });
        const port = args.port || await new Promise(resolve => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
        let sid, connected = false;
        try {
            const created = await this.servers.call('create', { version: map.version, world: plan ? plan.copiedWorldPath : map.path, port, acceptEula: args.acceptEula, software: 'vanilla', signal: args.signal });
            sid = created.sessionId || created.id;
            const properties = path.join(created.directory, 'server.properties');
            await fs.appendFile(properties, `\ngamemode=spectator\nforce-gamemode=true\nview-distance=${viewDistance}\n` + Object.entries(plan?.serverProperties || {}).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
            await this.servers.call('start', { session: sid, javaPath: await this.javaPath(args), memoryMb: args.memoryMb || 2048, signal: args.signal, wait: true, timeoutMs: args.timeoutMs || 180000 });
            let imported;
            if (plan)
                imported = await applyMapStage(plan, { sendCommand: command => this.servers.call('command', { session: sid, text: command, signal: args.signal }), readLogs: () => this.servers.call('logs', { session: sid, limit: 500 }), signal: args.signal, timeoutMs: args.timeoutMs });
            if (args.signal?.aborted)
                fail('CANCELLED', 'Map staging cancelled');
            await this.bridges.request(peer.id, 'connect', { host: '127.0.0.1', port });
            connected = true;
            let observation;
            for (let i = 0; i < 120; i++) {
                if (args.signal?.aborted)
                    fail('CANCELLED', 'Map connection cancelled');
                observation = await this.bridges.request(peer.id, 'observe', {});
                if (observation.connected && !observation.screen && !observation.loading)
                    break;
                if (i === 119)
                    fail('CONNECT_TIMEOUT', 'Client did not finish loading the staged world');
                await sleep(500, undefined, { signal: args.signal });
            }
            const username = observation.player?.name || observation.username;
            if (!username || !/^[A-Za-z0-9_]{1,16}$/.test(username))
                fail('CLIENT_TELEMETRY', 'Client must expose its player name for spectator camera setup');
            await this.servers.call('command', { session: sid, text: `gamemode spectator ${username}` });
            if (plan) {
                const p = plan.focus;
                await this.servers.call('command', { session: sid, text: `execute in ${plan.dimension} run tp ${username} ${p.x} ${p.y} ${p.z}` });
                await verifyStageSources(plan, args.signal);
            }
            const finalObservation = await this.bridges.request(peer.id, 'observe', {});
            if (args.signal?.aborted)
                fail('CANCELLED', 'Map staging cancelled before commit');
            const native = { client: peer.id, server: sid, source: map.path, version: map.version, dimension: map.dimension };
            this.nativeMaps.set(args.session, native);
            return { session: args.session, native, originalWorldModified: false, imported, cameraMode: 'spectator-in-world-copy', ...finalObservation };
        }
        catch (error) {
            if (connected)
                await this.bridges.request(peer.id, 'disconnect', {}).catch(() => { });
            if (sid)
                try {
                    await this.servers.call('stop', { session: sid, force: true });
                }
                catch (cleanup) {
                    fail('CANCELLATION_CLEANUP_FAILED', 'Staged server could not be stopped', { cause: error.message, cleanup: cleanup.message, server: sid });
                }
            if (plan) {
                const directory = path.resolve(path.dirname(plan.planPath)), root = path.resolve(this.options.stateDir, 'map-stages');
                if (directory.startsWith(root + path.sep))
                    await fs.rm(directory, { recursive: true, force: true });
            }
            if (args.signal?.aborted && error.code !== 'CANCELLATION_CLEANUP_FAILED')
                fail('CANCELLED', 'Map staging cancelled and server stopped');
            throw error;
        }
    }
    async nativeCamera(native, args) {
        for (const field of ['position', 'target'])
            if (args[field] && ['x', 'y', 'z'].some(k => !Number.isFinite(args[field][k])))
                fail('INVALID_ARGUMENT', `Camera ${field} coordinates must be finite`);
        let observation = await this.bridges.request(native.client, 'observe', {});
        const player = observation.player, name = player?.name || observation.username;
        if (!name || !/^[A-Za-z0-9_]{1,16}$/.test(name))
            fail('CLIENT_TELEMETRY', 'Missing player name');
        if (args.position) {
            const position = args.position, dimension = native.dimension && /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(native.dimension) ? `execute in ${native.dimension} run ` : '';
            await this.servers.call('command', { session: native.server, text: `${dimension}tp ${name} ${position.x} ${position.y} ${position.z}` });
            await sleep(150);
            observation = await this.bridges.request(native.client, 'observe', {});
        }
        const actual = observation.player;
        if (!actual || ['x', 'y', 'z'].some(k => !Number.isFinite(actual[k])))
            fail('CLIENT_TELEMETRY', 'Missing actual camera player coordinates');
        const actualPosition = { x: actual.x, y: actual.y, z: actual.z }, eyePosition = { x: actual.x, y: actual.y + 1.62, z: actual.z };
        if (args.target) {
            const dx = args.target.x - eyePosition.x, dy = args.target.y - eyePosition.y, dz = args.target.z - eyePosition.z;
            await this.bridges.request(native.client, 'look', { yaw: Math.atan2(-dx, dz), pitch: -Math.atan2(dy, Math.hypot(dx, dz)) });
        }
        observation = await this.bridges.request(native.client, 'observe', {});
        return { ...observation, cameraMode: 'spectator-in-world-copy', requestedPosition: args.position ? { ...args.position } : undefined, actualPosition, eyePosition, eyeHeight: 1.62, ...(args.target ? { target: { ...args.target } } : {}) };
    }
    async interiorTour(args) {
        const inspection = await loadInspection(args.inspection);
        if (!inspection?.targets || !args.player)
            fail('INVALID_ARGUMENT', 'interior tour requires --inspection FILE and --player SESSION');
        const native = this.bridges.peers.has(args.player);
        const check = native ? await inspectNative(this.bridges, { ...args, client: args.player, inspection }, this.options.artifactDir) : await this.maps.call('interior-check', { ...args, inspection });
        const results = [];
        for (const target of inspection.targets) {
            if (args.signal?.aborted)
                fail('CANCELLED', 'Interior tour cancelled');
            try {
                const targetCheck = check.targets.find((t) => t.id === target.id);
                if (native && targetCheck?.status !== 'reachable')
                    fail('NO_WALKING_PATH', 'Target has no confirmed native walking path', targetCheck);
                const movement = native ? await this.navigation.move(args.player, { target: target.position, bounds: inspection.bounds, timeoutMs: args.timeoutMs || 20000, signal: args.signal }) : await this.player('move', { session: args.player, position: target.position, timeoutMs: args.timeoutMs || 20000 });
                const observation = await this.player('observe', { session: args.player });
                if (check.version && (observation.version || observation.gameVersion) !== check.version)
                    fail('VERSION_MISMATCH', 'Map and live player versions differ');
                const actualDimension = observation.game?.dimension;
                if (inspection.dimension && actualDimension && String(inspection.dimension).replace('minecraft:', '') !== String(actualDimension).replace('minecraft:', ''))
                    fail('DIMENSION_MISMATCH', 'Map and live player dimensions differ');
                const p = observation.position || observation.player, targetPosition = target.position;
                if (!p || Math.hypot(p.x - targetPosition.x, p.y - targetPosition.y, p.z - targetPosition.z) > 0.8)
                    fail('TARGET_NOT_REACHED', 'Player did not reach the specified inspection target', { actual: p, target: targetPosition });
                const captures = [];
                for (let direction = 0; direction < 4; direction++) {
                    if (args.signal?.aborted)
                        fail('CANCELLED', 'Interior tour cancelled');
                    await this.player('look', { session: args.player, ...(target.lookAt && direction === 0 ? { target: target.lookAt } : { yaw: direction * Math.PI / 2, pitch: 0 }) });
                    try {
                        captures.push(await this.player('capture', { session: args.player }));
                    }
                    catch (error) {
                        captures.push({ error: { code: error.code, message: error.message } });
                    }
                }
                results.push({ id: target.id, liveVerified: true, movement, observation, captures });
            }
            catch (error) {
                results.push({ id: target.id, liveVerified: false, error: { code: error.code || 'TOUR_FAILED', message: error.message, details: error.details } });
                if (error.code === 'CANCELLED')
                    break;
            }
        }
        const report = { ...check, tour: results, observedAt: new Date().toISOString() };
        const reportPath = path.join(this.options.artifactDir, `tour-${Date.now()}.json`);
        await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
        return { ...report, reportPath };
    }
    async doctor(args) {
        const manifestPath = path.join(this.options.stateDir, 'versions.json');
        let manifest;
        try {
            if (!args.refresh)
                manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        }
        catch { }
        if (!manifest) {
            const response = await fetch('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', { signal: args.signal ? AbortSignal.any([args.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
            if (!response.ok)
                fail('NETWORK_ERROR', 'Cannot fetch official version manifest');
            manifest = await response.json();
            await fs.writeFile(manifestPath, JSON.stringify(manifest));
        }
        const versions = releaseTargets(manifest.versions).map((v) => v.id);
        const runtimes = await discoverJava(await this.javaPath(args), args.signal);
        const java = runtimes.length ? { available: true, runtimes } : { available: false, message: 'Set JAVA_HOME, MCT_JAVA, or pass --java-path to test start' };
        const mf = require('mineflayer');
        let builds = null;
        try {
            builds = JSON.parse(await fs.readFile(path.resolve('bridges/fabric/compatibility.json'), 'utf8'));
        }
        catch { }
        return { node: process.version, stateDir: this.options.stateDir, artifactDir: this.options.artifactDir, java, targetVersions: versions, latestRelease: manifest.latest.release, protocolBotVersions: mf.testedVersions || mf.supportedVersions || [], bridges: await this.bridges.call('list', args), fabricBuilds: builds, certification: 'Runtime support is recorded separately from build availability; no game runtime is certified by compilation alone.' };
    }
    async close() { this.navigation.close(); await this.jobs.close(); await Promise.allSettled([this.maps.close(), this.players.close(), this.servers.close(), this.models.close(), this.bridges.close()]); }
}
//# sourceMappingURL=app.js.map