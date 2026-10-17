import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { ToolError, fail, finite, id, required } from '../contracts.js';
const require = createRequire(import.meta.url);
export function requireExactVersion(version, supported) {
    if (!supported.includes(version))
        fail('CLIENT_REQUIRED', `Mineflayer does not advertise exact support for ${version}. Connect a matching Fabric client with mct client instead.`, { version, backend: 'mineflayer', advertisedVersions: supported, fallback: 'fabric-client', protocolDowngrade: false });
}
export function instrumentViewerBundle(bundle) {
    // prismarine-viewer 1.33 does not expose its viewer instance. Add a local,
    // in-memory observation hook; leave the installed package untouched.
    const pattern = /const ([\w$]+)=new ([\w$]+)\(([\w$]+)\);let ([\w$]+)=new THREE\.OrbitControls/g;
    const matches = [...bundle.matchAll(pattern)];
    if (matches.length !== 1)
        fail('VIEWER_INCOMPATIBLE', 'Installed Prismarine viewer bundle cannot expose a render-completion hook. Use a matching Fabric client.');
    return bundle.replace(pattern, 'const $1=new $2($3);window.viewer=$1;window.mctRenderer=$3;let $4=new THREE.OrbitControls');
}
export function boundedMs(value, fallback = 10000, max = 60000) {
    const n = value === undefined ? fallback : finite(value, 'timeoutMs');
    if (n < 1 || n > max)
        fail('INVALID_ARGUMENT', `timeoutMs must be between 1 and ${max}`);
    return n;
}
const point = (a) => ({ x: finite(a.x, 'x'), y: finite(a.y, 'y'), z: finite(a.z, 'z') });
const position = (p) => p && ({ x: p.x, y: p.y, z: p.z });
const item = (v) => v ? ({ name: v.name, displayName: v.displayName, count: v.count, slot: v.slot, type: v.type, metadata: v.metadata, components: v.components, nbt: v.nbt }) : null;
export function abortPlayerOperation(signal) { if (signal?.aborted)
    fail('CANCELLED', 'Player operation was cancelled'); }
export async function withDeadline(operation, timeoutMs, signal) {
    let timer;
    let abort;
    try {
        return await Promise.race([operation, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new ToolError('TIMEOUT', `Operation exceeded ${timeoutMs} ms`)), timeoutMs);
                abort = () => reject(new ToolError('CANCELLED', 'Operation was cancelled'));
                if (signal?.aborted)
                    abort();
                else
                    signal?.addEventListener('abort', abort, { once: true });
            })]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
        if (abort)
            signal?.removeEventListener('abort', abort);
    }
}
export class PlayerService {
    options;
    dependencies;
    sessions = new Map();
    shutdown = new AbortController();
    operations = new Set();
    constructor(options, dependencies = {}) {
        this.options = options;
        this.dependencies = dependencies;
    }
    libs() {
        return {
            mineflayer: this.dependencies.mineflayer ?? require('mineflayer'),
            pathfinder: this.dependencies.pathfinder ?? require('mineflayer-pathfinder'),
            Vec3: this.dependencies.vec3 ?? require('vec3').Vec3,
        };
    }
    get(args) {
        const s = this.sessions.get(required(args.session ?? args.sessionId, 'session'));
        if (!s)
            fail('SESSION_NOT_FOUND', 'Player session was not found');
        return s;
    }
    connected(args) {
        const s = this.get(args);
        if (s.state !== 'connected')
            fail('NOT_CONNECTED', 'Player session is not connected', { state: s.state, lastError: s.lastError });
        return s;
    }
    metadata(s) {
        return { sessionId: s.id, kind: 'player', backend: 'mineflayer', source: 'server-protocol', version: s.version, observedAt: new Date().toISOString(), state: s.state, host: s.host, port: s.port, auth: s.auth, authentication: s.state === 'connecting' ? s.authentication : undefined };
    }
    observe(s) {
        const b = s.bot;
        return { ...this.metadata(s), position: position(b.entity?.position), yaw: b.entity?.yaw, pitch: b.entity?.pitch,
            health: b.health, food: b.food, game: b.game, username: b.username,
            heldItem: item(b.heldItem), messages: s.messages.slice(-50),
            window: b.currentWindow ? { id: b.currentWindow.id, title: String(b.currentWindow.title), type: b.currentWindow.type, slots: b.currentWindow.slots.map(item) } : null,
            capabilities: { move: true, look: true, inventory: true, interact: true, chat: true, capture: 'prismarine-viewer', nativeHud: false, resourcePacks: false, liveVersionValidated: false },
            limitation: 'Protocol observation and approximate viewer; native HUD, resource packs and exact game rendering require the Fabric client bridge.',
            lastError: s.lastError };
    }
    release(s) {
        s.controller?.abort();
        try {
            s.bot.pathfinder?.setGoal(null);
        }
        catch { }
        try {
            s.bot.clearControlStates();
        }
        catch { }
        try {
            s.bot.deactivateItem?.();
        }
        catch { }
    }
    async disconnect(s, reason) {
        if (s.state === 'disconnected')
            return;
        const bot = s.bot;
        let ended;
        let timer;
        const closed = new Promise(resolve => { ended = resolve; bot.once('end', ended); });
        try {
            // Mineflayer injects quit only after its first plugin tick. end is
            // available immediately after createBot, including abort-before-login.
            if (typeof bot.quit === 'function')
                bot.quit(reason);
            else if (typeof bot.end === 'function')
                bot.end(reason);
            else
                bot._client?.end(reason);
            await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
            if (s.state !== 'disconnected') {
                bot._client?.socket?.destroy();
                await withDeadline(closed, 3000);
            }
        }
        catch (error) {
            fail('CANCELLATION_CLEANUP_FAILED', 'Player connection did not close during cleanup', { sessionId: s.id, cause: error.message });
        }
        finally {
            if (timer)
                clearTimeout(timer);
            if (ended)
                bot.removeListener('end', ended);
        }
    }
    async protocolOperation(s, args, run) {
        abortPlayerOperation(args.signal);
        const controller = new AbortController();
        s.operations.add(controller);
        const signal = AbortSignal.any([controller.signal, args.signal]);
        try {
            await withDeadline(run(), boundedMs(args.timeoutMs), signal);
            abortPlayerOperation(signal);
        }
        catch (error) {
            if (signal.aborted || error.code === 'TIMEOUT') {
                this.release(s);
                try {
                    if (s.bot.currentWindow)
                        s.bot.closeWindow(s.bot.currentWindow);
                }
                catch { }
                // Mineflayer has no cancellation primitive for a pending inventory
                // transaction or container open. End this owned connection before return
                // so a delayed server response cannot change a supposedly cancelled GUI.
                await this.disconnect(s, 'mct cancelled protocol operation');
            }
            throw error;
        }
        finally {
            s.operations.delete(controller);
        }
    }
    async call(action, args = {}) {
        if (args.signal !== undefined && !(args.signal instanceof AbortSignal))
            fail('INVALID_ARGUMENT', 'signal must be an AbortSignal');
        const signal = args.signal ? AbortSignal.any([this.shutdown.signal, args.signal]) : this.shutdown.signal;
        abortPlayerOperation(signal);
        const operation = this.dispatch(action, { ...args, signal });
        this.operations.add(operation);
        try {
            const result = await operation;
            abortPlayerOperation(signal);
            return result;
        }
        catch (error) {
            if (error.code !== 'CANCELLATION_CLEANUP_FAILED')
                abortPlayerOperation(signal);
            throw error;
        }
        finally {
            this.operations.delete(operation);
        }
    }
    async dispatch(action, args) {
        if (action === 'list')
            return { sessions: [...this.sessions.values()].map(s => this.metadata(s)) };
        if (action === 'versions') {
            const { mineflayer } = this.libs();
            return { backend: 'mineflayer', advertisedVersions: mineflayer.supportedVersions ?? mineflayer.testedVersions ?? [], locallyTestedVersions: [], fallback: 'fabric-client' };
        }
        if (action === 'connect')
            return this.connect(args);
        const s = ['disconnect', 'close', 'stop', 'observe'].includes(action) ? this.get(args) : this.connected(args);
        const b = s.bot;
        if (action === 'observe')
            return this.observe(s);
        if (action === 'stop') {
            for (const c of s.operations)
                c.abort();
            this.release(s);
            return { ...this.metadata(s), stopped: true, inputsReleased: true };
        }
        if (action === 'disconnect' || action === 'close') {
            for (const c of s.operations)
                c.abort();
            this.release(s);
            await this.disconnect(s, 'mct disconnected');
            await s.viewer?.close();
            s.viewer = undefined;
            s.state = 'disconnected';
            return this.metadata(s);
        }
        if (action === 'look') {
            const { Vec3 } = this.libs();
            if (args.target) {
                const p = point(args.target);
                await withDeadline(b.lookAt(new Vec3(p.x, p.y, p.z), true), boundedMs(args.timeoutMs), args.signal);
            }
            else {
                const yaw = finite(args.yaw, 'yaw');
                const pitch = finite(args.pitch ?? 0, 'pitch');
                if (Math.abs(pitch) > Math.PI / 2)
                    fail('INVALID_ARGUMENT', 'pitch is in radians and must be between -pi/2 and pi/2');
                await withDeadline(b.look(yaw, pitch, true), boundedMs(args.timeoutMs), args.signal);
            }
            return this.observe(s);
        }
        if (action === 'move')
            return this.move(s, args);
        if (action === 'tour') {
            if (!Array.isArray(args.points) || args.points.length > 256)
                fail('INVALID_ARGUMENT', 'points must contain at most 256 visit positions');
            const visits = [];
            for (const p of args.points) {
                abortPlayerOperation(args.signal);
                try {
                    const result = await this.move(s, { ...p, signal: args.signal, timeoutMs: args.timeoutMs ?? 15000 });
                    visits.push({ name: p.name, reached: true, result });
                }
                catch (e) {
                    visits.push({ name: p.name, reached: false, code: e.code, message: e.message, position: position(b.entity?.position) });
                    if (e.code === 'CANCELLED')
                        break;
                }
            }
            return { ...this.metadata(s), visits };
        }
        if (action === 'chat' || action === 'command') {
            const text = String(required(args.text ?? args.command, 'text'));
            if (/[\r\n]/.test(text) || text.length > 256)
                fail('INVALID_ARGUMENT', 'Send one chat message or command, at most 256 characters');
            b.chat(action === 'command' && !text.startsWith('/') ? `/${text}` : text);
            return { ...this.metadata(s), sent: true, channel: action === 'command' ? 'player-command' : 'chat', response: 'Server replies arrive in observe.messages; sending does not imply command success.' };
        }
        if (action === 'inventory') {
            const op = args.operation ?? 'list';
            if (op === 'close') {
                if (b.currentWindow)
                    b.closeWindow(b.currentWindow);
            }
            else if (op === 'select') {
                const slot = finite(args.slot, 'slot');
                if (!Number.isInteger(slot) || slot < 0 || slot > 8)
                    fail('INVALID_ARGUMENT', 'Hotbar slot must be 0..8');
                b.setQuickBarSlot(slot);
            }
            else if (op === 'click') {
                const slots = (b.currentWindow ?? b.inventory).slots;
                const slot = finite(args.slot, 'slot');
                if (!Number.isInteger(slot) || slot < 0 || slot >= slots.length)
                    fail('INVALID_ARGUMENT', 'slot is outside current window');
                const button = finite(args.button ?? 0, 'button');
                const mode = finite(args.mode ?? 0, 'mode');
                if (![0, 1].includes(button) || ![0, 1].includes(mode))
                    fail('INVALID_ARGUMENT', 'Only left/right normal/shift clicks are supported (button 0/1, mode 0/1)');
                await this.protocolOperation(s, args, () => b.clickWindow(slot, button, mode));
            }
            else if (op !== 'list')
                fail('INVALID_ARGUMENT', 'inventory operation must be list, close, select or click');
            return { ...this.metadata(s), slots: b.inventory.slots.map(item), quickBarSlot: b.quickBarSlot, window: this.observe(s).window };
        }
        if (action === 'interact') {
            const { Vec3 } = this.libs();
            const p = point(args.position ?? args);
            const pos = new Vec3(p.x, p.y, p.z);
            const block = b.blockAt(pos);
            if (!block)
                fail('CHUNK_UNAVAILABLE', 'Block is outside loaded chunks', { position: p });
            if (b.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 5)
                fail('OUT_OF_REACH', 'Move within 5 blocks before interacting');
            await this.protocolOperation(s, args, () => args.operation === 'open' ? b.openContainer(block) : b.activateBlock(block));
            return { ...this.metadata(s), interacted: { position: p, block: block.name }, window: this.observe(s).window };
        }
        if (action === 'capture' || action === 'viewer')
            return this.capture(s, args, action === 'viewer');
        fail('UNKNOWN_ACTION', `Unknown player action: ${action}`);
    }
    async connect(args) {
        abortPlayerOperation(args.signal);
        const controller = new AbortController();
        args = { ...args, signal: AbortSignal.any([controller.signal, args.signal]) };
        const version = String(required(args.version, 'version'));
        const { mineflayer, pathfinder } = this.libs();
        requireExactVersion(version, mineflayer.supportedVersions ?? mineflayer.testedVersions ?? []);
        const port = finite(args.port ?? 25565, 'port');
        if (!Number.isInteger(port) || port < 1 || port > 65535)
            fail('INVALID_ARGUMENT', 'port must be 1..65535');
        if (args.auth !== undefined && !['offline', 'microsoft'].includes(args.auth))
            fail('INVALID_ARGUMENT', 'auth must be offline or microsoft');
        const auth = args.auth === 'microsoft' ? 'microsoft' : 'offline';
        if (auth === 'microsoft')
            required(args.username, 'username (Microsoft account identifier)');
        const sessionId = id('player');
        let challenge;
        const challengeReady = new Promise(resolve => { challenge = resolve; });
        let s;
        if (auth === 'microsoft')
            await mkdir(join(this.options.stateDir, 'auth'), { recursive: true });
        abortPlayerOperation(args.signal);
        const bot = mineflayer.createBot({ host: String(args.host ?? '127.0.0.1'), port, username: String(args.username ?? 'MCTObserver'), version, auth, hideErrors: true, logErrors: false, checkTimeoutInterval: 20000, viewDistance: 'short',
            ...(auth === 'microsoft' ? { profilesFolder: join(this.options.stateDir, 'auth'), onMsaCode: (code) => {
                    if (s)
                        s.authentication = { verificationUri: String(code.verification_uri ?? code.verificationUri ?? 'https://www.microsoft.com/link'), userCode: String(code.user_code ?? code.userCode ?? ''), expiresAt: new Date(Date.now() + Number(code.expires_in ?? 900) * 1000).toISOString() };
                    challenge?.();
                } } : {}) });
        s = { id: sessionId, bot, version, auth, host: String(args.host ?? '127.0.0.1'), port, state: 'connecting', messages: [], operations: new Set([controller]) };
        const session = s;
        this.sessions.set(s.id, s);
        bot.on('messagestr', (text) => { session.messages.push({ text, at: new Date().toISOString() }); if (session.messages.length > 200)
            session.messages.shift(); });
        bot.on('error', (e) => { session.lastError = e.message; this.release(session); });
        bot.on('end', () => { session.state = 'disconnected'; for (const c of session.operations)
            c.abort(); this.release(session); void session.viewer?.close().catch((e) => { session.lastError = e.message; }); session.viewer = undefined; });
        bot.on('kicked', (reason) => { session.lastError = String(reason); this.release(session); });
        let spawned;
        let errored;
        let ended;
        const connect = (async () => {
            try {
                await withDeadline(new Promise((resolve, reject) => {
                    spawned = () => resolve();
                    errored = e => reject(e);
                    ended = reason => reject(new ToolError('CONNECTION_ENDED', `Connection ended before spawn: ${reason}`));
                    bot.once('spawn', spawned);
                    bot.once('error', errored);
                    bot.once('end', ended);
                }), auth === 'microsoft' ? boundedMs(args.timeoutMs, 300000, 900000) : boundedMs(args.timeoutMs, 20000), args.signal);
                abortPlayerOperation(args.signal);
                if (bot.version !== version)
                    fail('VERSION_MISMATCH', 'Server negotiated a different game version', { requested: version, negotiated: bot.version });
                bot.loadPlugin(pathfinder.pathfinder);
                session.state = 'connected';
                session.authentication = undefined;
                return this.observe(session);
            }
            catch (e) {
                this.release(session);
                session.lastError = e.message;
                await this.disconnect(session, 'mct connection failed');
                this.sessions.delete(session.id);
                throw e;
            }
            finally {
                session.operations.delete(controller);
                if (spawned)
                    bot.removeListener('spawn', spawned);
                if (errored)
                    bot.removeListener('error', errored);
                if (ended)
                    bot.removeListener('end', ended);
            }
        })();
        session.connection = connect;
        if (auth === 'microsoft')
            return Promise.race([connect, challengeReady.then(() => ({ ...this.metadata(session), authPending: true, instruction: 'Open verificationUri and enter userCode in your browser. Poll player observe for connected state. Tokens are cached only in the private state/auth directory.' }))]);
        return connect;
    }
    async move(s, args) {
        abortPlayerOperation(args.signal);
        if (s.controller)
            fail('SESSION_BUSY', 'A movement is already running; stop it before issuing another');
        const controller = new AbortController();
        s.controller = controller;
        const signal = args.signal ? AbortSignal.any([controller.signal, args.signal]) : controller.signal;
        const b = s.bot;
        const timeoutMs = boundedMs(args.timeoutMs, 10000);
        try {
            const { pathfinder, Vec3 } = this.libs();
            if (args.x !== undefined || args.target) {
                const p = point(args.target ?? args);
                const movement = new pathfinder.Movements(b);
                movement.canDig = false;
                movement.allow1by1towers = false;
                movement.allowParkour = false;
                movement.allowSprinting = false;
                movement.allowFreeMotion = false;
                movement.canOpenDoors = false;
                movement.scafoldingBlocks = [];
                movement.maxDropDown = 1;
                movement.exclusionAreasPlace = [() => 100];
                movement.exclusionAreasBreak = [() => 100];
                b.pathfinder.setMovements(movement);
                b.pathfinder.searchRadius = 64;
                const range = finite(args.range ?? 0.7, 'range');
                if (range < 0 || range > 2)
                    fail('INVALID_ARGUMENT', 'range must be between 0 and 2');
                const goal = new pathfinder.goals.GoalNear(p.x, p.y, p.z, range);
                await withDeadline(b.pathfinder.goto(goal), timeoutMs, signal);
                abortPlayerOperation(signal);
                const measuredDistance = b.entity.position.distanceTo(new Vec3(p.x, p.y, p.z));
                // Pathfinder works in floored block coordinates; the largest offset to
                // the centre of the requested standing block is sqrt(0.5² + 0.5²).
                const actualTolerance = Math.max(range, 0.8);
                if (measuredDistance > actualTolerance)
                    fail('TARGET_NOT_REACHED', 'Pathfinder stopped away from target', { target: p, actual: position(b.entity.position), measuredDistance, actualTolerance });
            }
            else {
                const controls = args.controls ?? [args.direction ?? 'forward'];
                if (!Array.isArray(controls) || !controls.length || controls.some((x) => !['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'].includes(x)))
                    fail('INVALID_ARGUMENT', 'controls must contain movement key names');
                const durationMs = boundedMs(args.durationMs, 500, Math.min(timeoutMs, 10000));
                for (const key of controls)
                    b.setControlState(key, true);
                let timer;
                try {
                    await withDeadline(new Promise(resolve => { timer = setTimeout(resolve, durationMs); }), timeoutMs + 100, signal);
                    abortPlayerOperation(signal);
                }
                finally {
                    if (timer)
                        clearTimeout(timer);
                }
            }
            return { ...this.observe(s), reached: true, inputsReleased: true };
        }
        finally {
            this.release(s);
            if (s.controller === controller)
                s.controller = undefined;
        }
    }
    async createViewer(s, signal) {
        abortPlayerOperation(signal);
        const express = require('express');
        const { Server: SocketServer } = require('socket.io');
        // Import only the protocol WorldView; requiring the package root also loads
        // a Node-side renderer and its unnecessary native canvas dependency.
        const { WorldView } = require('prismarine-viewer/viewer/lib/worldView');
        const { setupRoutes } = require('prismarine-viewer/lib/common');
        const app = express();
        const http = createServer(app);
        const io = new SocketServer(http);
        const publicDir = join(dirname(require.resolve('prismarine-viewer')), 'public');
        const bundle = instrumentViewerBundle(await readFile(join(publicDir, 'index.js'), { encoding: 'utf8', signal }));
        abortPlayerOperation(signal);
        app.get('/index.js', (_req, res) => res.type('application/javascript').send(bundle));
        setupRoutes(app);
        const sockets = new Set();
        io.on('connection', (socket) => {
            sockets.add(socket);
            socket.emit('version', s.version);
            const worldView = new WorldView(s.bot.world, 3, s.bot.entity.position, socket);
            const update = () => { socket.emit('position', { pos: s.bot.entity.position, yaw: s.bot.entity.yaw, pitch: s.bot.entity.pitch, addMesh: false }); void worldView.updatePosition(s.bot.entity.position).catch((e) => { s.lastError = e.message; }); };
            void worldView.init(s.bot.entity.position).catch((e) => { s.lastError = e.message; });
            worldView.listenToBot(s.bot);
            s.bot.on('move', update);
            update();
            socket.on('disconnect', () => { sockets.delete(socket); s.bot.removeListener('move', update); worldView.removeListenersFromBot(s.bot); });
        });
        try {
            await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', () => resolve()); });
        }
        catch (error) {
            io.close();
            if (http.listening)
                http.close();
            throw error;
        }
        const address = http.address();
        if (!address || typeof address === 'string')
            fail('VIEWER_FAILED', 'Viewer did not receive a loopback port');
        let assetsVersion = null;
        try {
            assetsVersion = require('prismarine-viewer/viewer/lib/version').getVersion(s.version);
        }
        catch { }
        let closing;
        const v = { url: `http://127.0.0.1:${address.port}`, assetsVersion,
            close: () => closing ??= (async () => { for (const socket of sockets)
                socket.disconnect(true); await new Promise(resolve => io.close(() => resolve())); if (http.listening)
                await new Promise(resolve => http.close(() => resolve())); })() };
        if (signal?.aborted) {
            await v.close();
            abortPlayerOperation(signal);
        }
        s.viewer = v;
        return v;
    }
    async capture(s, args, viewerOnly = false) {
        abortPlayerOperation(args.signal);
        const controller = new AbortController();
        s.operations.add(controller);
        const signal = AbortSignal.any([controller.signal, args.signal]);
        let browser;
        let browserClosing;
        let imagePath;
        let newViewer;
        const closeBrowser = () => browserClosing ??= browser ? browser.close() : Promise.resolve();
        const aborted = () => { if (browser)
            void closeBrowser().catch(() => { }); };
        signal.addEventListener('abort', aborted, { once: true });
        try {
            if (!s.viewer) {
                const owner = !s.viewerPending;
                s.viewerPending ??= this.createViewer(s, signal);
                try {
                    const v = await s.viewerPending;
                    if (owner)
                        newViewer = v;
                }
                finally {
                    if (owner)
                        s.viewerPending = undefined;
                }
            }
            abortPlayerOperation(signal);
            const viewer = s.viewer;
            if (!viewer.assetsVersion)
                fail('CLIENT_REQUIRED', `No Prismarine viewer asset set is available for ${s.version}. Use the matching Fabric client for screenshots.`, { version: s.version });
            const provenance = { ...this.metadata(s), source: 'prismarine-viewer', imageSource: 'approximate-protocol-renderer', assetsVersion: viewer.assetsVersion, nativeHud: false, resourcePacks: false, rendererUrl: viewer.url,
                limitations: ['Vanilla viewer assets may differ from the exact game version.', 'HUD, custom models and resource packs require the actual Fabric game client.'] };
            if (viewerOnly)
                return provenance;
            const playwright = this.dependencies.playwright ?? require('playwright');
            const width = finite(args.width ?? 1280, 'width');
            const height = finite(args.height ?? 720, 'height');
            if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 4096 || height > 4096)
                fail('INVALID_ARGUMENT', 'width and height must be integer pixels between 64 and 4096');
            // A launch cannot be cancelled by Playwright. Await its settlement, then
            // close the owned process before acknowledging an abort during startup.
            browser = await playwright.chromium.launch({ headless: true, timeout: 30000, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
            abortPlayerOperation(signal);
            const page = await browser.newPage({ viewport: { width, height } });
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            await page.goto(viewer.url, { waitUntil: 'networkidle', timeout: 30000 });
            // Published viewer exposes window.viewer. Require actual meshing and a populated
            // scene rather than treating an arbitrary delay or blank canvas as observation.
            await page.waitForFunction(() => {
                const w = globalThis.viewer?.world;
                return w && Object.keys(w.loadedChunks ?? {}).length > 0 && (w.sectionsOutstanding?.size ?? 1) === 0 && Object.keys(w.sectionMeshs ?? {}).length > 0;
            }, undefined, { timeout: boundedMs(args.timeoutMs, 30000) });
            await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
            if (errors.length)
                fail('VIEWER_FAILED', 'Viewer reported rendering errors', { errors });
            abortPlayerOperation(signal);
            await mkdir(this.options.artifactDir, { recursive: true });
            abortPlayerOperation(signal);
            imagePath = join(this.options.artifactDir, `${s.id}-${Date.now()}.png`);
            await page.screenshot({ path: imagePath });
            abortPlayerOperation(signal);
            const result = { ...provenance, observedAt: new Date().toISOString(), imagePath, width, height, position: position(s.bot.entity.position), yaw: s.bot.entity.yaw, pitch: s.bot.entity.pitch };
            await writeFile(`${imagePath}.json`, JSON.stringify(result, null, 2), { signal });
            abortPlayerOperation(signal);
            return result;
        }
        catch (e) {
            abortPlayerOperation(signal);
            if (e instanceof ToolError)
                throw e;
            fail('CAPTURE_FAILED', e.message, { installBrowser: 'npx playwright install chromium', rendererUrl: s.viewer?.url });
        }
        finally {
            signal.removeEventListener('abort', aborted);
            s.operations.delete(controller);
            try {
                await closeBrowser();
                if (signal.aborted) {
                    if (newViewer) {
                        await newViewer.close();
                        if (s.viewer === newViewer)
                            s.viewer = undefined;
                    }
                    if (imagePath) {
                        await rm(imagePath, { force: true });
                        await rm(`${imagePath}.json`, { force: true });
                    }
                }
            }
            catch (error) {
                fail('CANCELLATION_CLEANUP_FAILED', 'Capture resources could not be closed', { sessionId: s.id, cause: error.message });
            }
        }
    }
    async close() {
        this.shutdown.abort();
        for (const s of this.sessions.values()) {
            for (const c of s.operations)
                c.abort();
            this.release(s);
        }
        await Promise.allSettled([...this.operations, ...[...this.sessions.values()].map(s => s.connection).filter(Boolean)]);
        for (const s of this.sessions.values()) {
            await this.disconnect(s, 'mct shutting down');
            await s.viewerPending?.catch(() => { });
            await s.viewer?.close();
            s.state = 'disconnected';
        }
    }
}
//# sourceMappingURL=index.js.map