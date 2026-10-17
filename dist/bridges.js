import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { fail, id } from './contracts.js';
export class BridgeService {
    options;
    peers = new Map();
    pending = new Map();
    constructor(options) {
        this.options = options;
    }
    register(socket, hello) {
        const peer = { id: id('bridge'), kind: String(hello.kind), name: String(hello.name || hello.kind), version: hello.version, capabilities: hello.capabilities || [], socket };
        this.peers.set(peer.id, peer);
        socket.on('message', raw => {
            try {
                const msg = JSON.parse(String(raw));
                const waiter = this.pending.get(msg.id);
                if (!waiter || waiter.peer !== peer.id)
                    return;
                clearTimeout(waiter.timer);
                this.pending.delete(msg.id);
                if (msg.error)
                    waiter.reject(Object.assign(new Error(msg.error.message || String(msg.error)), { code: msg.error.code || 'BRIDGE_ERROR' }));
                else
                    waiter.resolve(msg.result);
            }
            catch { /* malformed unsolicited messages do not complete requests */ }
        });
        socket.on('close', () => {
            this.peers.delete(peer.id);
            for (const [key, waiter] of this.pending)
                if (waiter.peer === peer.id) {
                    clearTimeout(waiter.timer);
                    waiter.reject(Object.assign(new Error('Bridge disconnected'), { code: 'BRIDGE_DISCONNECTED' }));
                    this.pending.delete(key);
                }
        });
        return peer;
    }
    publicPeer(peer) { const { socket, token, ...visible } = peer; return visible; }
    async discover(directory) {
        const dirs = directory ? [path.resolve(directory), path.resolve(directory, '.mct')] : [path.join(this.options.stateDir, 'clients'), path.join(os.homedir(), 'AppData', 'Roaming', '.minecraft', '.mct')];
        const found = [];
        for (const dir of dirs) {
            const entries = await fs.readdir(dir).catch(() => []);
            for (const name of entries.filter(n => n.endsWith('.json'))) {
                try {
                    const file = path.join(dir, name);
                    const data = JSON.parse(await fs.readFile(file, 'utf8'));
                    if (data.kind === 'fabric' && Number.isInteger(data.port))
                        found.push({ discovery: file, kind: data.kind, pid: data.pid, gameVersion: data.gameVersion, port: data.port });
                }
                catch { }
            }
        }
        return found;
    }
    async attach(discovery) {
        const file = path.resolve(discovery);
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        if (data.kind !== 'fabric' || !Number.isInteger(data.port) || data.port < 1 || data.port > 65535 || typeof data.token !== 'string' || !data.token)
            fail('INVALID_DISCOVERY', 'Invalid Fabric discovery file');
        const existing = [...this.peers.values()].find(p => p.discovery === file);
        if (existing)
            return this.publicPeer(existing);
        const peer = { id: id('client'), kind: 'fabric', name: `Minecraft ${data.gameVersion}`, version: data.gameVersion, capabilities: [], port: data.port, token: data.token, discovery: file };
        const status = await this.http(peer, undefined);
        if (status.gameVersion && status.gameVersion !== peer.version)
            fail('VERSION_MISMATCH', 'Discovery and game versions differ');
        peer.capabilities = status.capabilities || ['observe', 'capture', 'look', 'input', 'inventory', 'gui', 'blocks', 'command', 'chat', 'stop'];
        this.peers.set(peer.id, peer);
        return this.publicPeer(peer);
    }
    async http(peer, action, args = {}) {
        const response = await fetch(`http://127.0.0.1:${peer.port}/${action ? 'call' : 'status'}`, { method: action ? 'POST' : 'GET', headers: { authorization: `Bearer ${peer.token}`, 'content-type': 'application/json' }, body: action ? JSON.stringify({ action, args }) : undefined, signal: AbortSignal.timeout(Number(args.timeoutMs || 20000)) });
        const data = await response.json().catch(() => fail('BRIDGE_PROTOCOL', 'Client returned non-JSON response'));
        if (!response.ok || data.error)
            fail(data.error?.code || 'BRIDGE_ERROR', data.error?.message || `Client HTTP ${response.status}`);
        return data.result ?? data;
    }
    async request(peerId, action, args = {}) {
        const peer = this.peers.get(peerId);
        if (!peer)
            fail('BRIDGE_NOT_FOUND', `Bridge ${peerId} is not connected`);
        if (!peer.port && (!peer.socket || peer.socket.readyState !== WebSocket.OPEN))
            fail('BRIDGE_DISCONNECTED', 'Bridge is no longer connected');
        let result;
        if (peer.port) {
            let nativeArgs = { ...args };
            if (action === 'look') {
                if (args.yaw === undefined || !Number.isFinite(Number(args.yaw)) || !Number.isFinite(Number(args.pitch ?? 0)) || Math.abs(Number(args.pitch ?? 0)) > Math.PI / 2)
                    fail('INVALID_ARGUMENT', 'look requires a finite yaw and pitch between -pi/2 and pi/2, in radians');
                nativeArgs = { ...args, yaw: Number(args.yaw) * 180 / Math.PI, pitch: Number(args.pitch ?? 0) * 180 / Math.PI };
            }
            if (action === 'inventory') {
                if (args.operation === 'select')
                    return this.request(peer.id, 'hotbar', { slot: args.slot, signal: args.signal });
                if (args.operation === 'close') {
                    await this.http(peer, 'input', { key: 'escape', action: 'press' });
                    nativeArgs = {};
                }
                if (args.mode === 0 || args.mode === 1)
                    nativeArgs.mode = args.mode === 0 ? 'PICKUP' : 'QUICK_MOVE';
            }
            result = await this.http(peer, action, nativeArgs);
        }
        else
            result = await new Promise((resolve, reject) => {
                const requestId = randomUUID();
                const timer = setTimeout(() => { this.pending.delete(requestId); reject(Object.assign(new Error(`Bridge timed out: ${action}`), { code: 'BRIDGE_TIMEOUT' })); }, Number(args.timeoutMs || 30000));
                this.pending.set(requestId, { peer: peer.id, resolve, reject, timer });
                peer.socket.send(JSON.stringify({ type: 'request', id: requestId, action, args }));
            });
        if (peer.kind === 'fabric' && result?.player) {
            result = { ...result, angleUnit: 'radians', player: { ...result.player, yaw: Number(result.player.yaw) * Math.PI / 180, pitch: Number(result.player.pitch) * Math.PI / 180 } };
        }
        if (result?.base64 || result?.dataUrl?.startsWith('data:image/png;base64,')) {
            const base64 = result.base64 || result.dataUrl.split(',')[1];
            if (base64.length > 100_000_000)
                fail('IMAGE_TOO_LARGE', 'Bridge image exceeds capture limit');
            const buffer = Buffer.from(base64, 'base64');
            if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
                fail('INVALID_IMAGE', 'Bridge did not return PNG data');
            const imagePath = path.join(this.options.artifactDir, `${id('capture')}.png`);
            await fs.mkdir(this.options.artifactDir, { recursive: true });
            await fs.writeFile(imagePath, buffer);
            const { base64: _, dataUrl: __, ...meta } = result;
            result = { ...meta, imagePath, mimeType: 'image/png' };
        }
        return { ...result, bridge: this.publicPeer(peer), source: peer.kind === 'fabric' ? 'minecraft-client' : 'blockbench', observedAt: result?.observedAt || new Date().toISOString() };
    }
    async call(action, args) {
        switch (action) {
            case 'list': return { connected: [...this.peers.values()].map(p => this.publicPeer(p)), discovered: await this.discover(args.directory) };
            case 'attach': return this.attach(String(args.path || args.discovery));
            case 'close':
            case 'detach': {
                const peer = this.peers.get(args.session || args.client);
                if (peer?.kind === 'fabric')
                    await this.request(peer.id, 'stop', {}).catch(() => { });
                if (peer) {
                    peer.socket?.close();
                    this.peers.delete(peer.id);
                }
                return { detached: !!peer };
            }
            default: return this.request(String(args.session || args.client || args.bridge), action, args);
        }
    }
    async close() { for (const peer of this.peers.values()) {
        if (peer.kind === 'fabric')
            await this.request(peer.id, 'stop', {}).catch(() => { });
        peer.socket?.close();
    } this.peers.clear(); }
}
//# sourceMappingURL=bridges.js.map