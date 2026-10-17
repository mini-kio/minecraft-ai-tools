import path from 'node:path';
import { fail, id, required } from './contracts.js';
import { watch } from 'node:fs';
import { fingerprint, readModelSource } from './model-source.js';
export class ModelService {
    bridges;
    sessions = new Map();
    controllers = new Map();
    sources = new Map();
    watchers = new Map();
    constructor(bridges) {
        this.bridges = bridges;
    }
    watchSource(session, source) {
        for (const watcher of this.watchers.get(session.id) || [])
            watcher.close();
        const watchers = [];
        for (const directory of new Set(source.files.map(file => path.dirname(file.path)))) {
            try {
                const watcher = watch(directory, { persistent: false }, () => { session.sourceChangePending = true; });
                watcher.on('error', () => { session.sourceChangePending = true; });
                watchers.push(watcher);
            }
            catch { /* Fingerprints also detect changes when filesystem watching is unavailable. */ }
        }
        this.watchers.set(session.id, watchers);
        this.sources.set(session.id, source);
        session.sourceChangePending = false;
    }
    async sourceStatus(session) {
        const baseline = this.sources.get(session.id);
        const files = await Promise.all((baseline?.files || []).map(file => fingerprint(file.path)));
        const changes = files.filter((file, index) => file.sha256 !== baseline?.files[index]?.sha256 || file.error !== baseline?.files[index]?.error);
        session.changed = changes.length > 0;
        session.sourceChangePending = false;
        return { changed: session.changed, sourceFiles: files, changedFiles: changes.map(file => file.path), fileTransport: 'cli-read-model-data', warnings: baseline?.warnings || [] };
    }
    async call(action, args) {
        if (action === 'list')
            return Promise.all([...this.sessions.values()].map(async (session) => ({ ...session, ...await this.sourceStatus(session) })));
        if (action === 'open') {
            const peer = args.bridge ? this.bridges.peers.get(args.bridge) : [...this.bridges.peers.values()].find(p => p.kind === 'blockbench');
            if (!peer || peer.kind !== 'blockbench')
                fail('BLOCKBENCH_REQUIRED', 'Load bridges/blockbench/mct_bridge.js in Blockbench, then reconnect. Run mct bridge config for configuration.');
            const file = path.resolve(String(required(args.path, 'path')));
            const source = await readModelSource(file, args.assetRoot);
            const result = await this.bridges.request(peer.id, 'model.open', { ...args, path: file, sourceText: source.sourceText });
            const session = { id: id('model'), kind: 'model', path: file, assetRoot: args.assetRoot, bridge: peer.id, project: result.project, openedAt: new Date().toISOString(), source: 'blockbench', changed: false };
            this.sessions.set(session.id, session);
            this.watchSource(session, source);
            return { ...session, model: result, ...await this.sourceStatus(session) };
        }
        const session = this.sessions.get(args.session);
        if (!session)
            fail('SESSION_NOT_FOUND', 'Model session not found');
        if (action === 'stop') {
            this.controllers.get(session.id)?.abort();
            return { session: session.id, stopped: true };
        }
        if (action === 'close')
            this.controllers.get(session.id)?.abort();
        if (action === 'sample') {
            const frames = Number(args.frames ?? 8), from = Number(args.from ?? 0), to = Number(args.to ?? 1);
            if (!Number.isInteger(frames) || frames < 1 || frames > 120 || !Number.isFinite(from) || !Number.isFinite(to) || to < from)
                fail('INVALID_ARGUMENT', 'sample requires frames 1..120 and finite from <= to');
            if (this.controllers.has(session.id))
                fail('SESSION_BUSY', 'A model sampling job is already running');
            const controller = new AbortController();
            this.controllers.set(session.id, controller);
            const abort = () => controller.abort();
            args.signal?.addEventListener('abort', abort, { once: true });
            if (args.signal?.aborted)
                controller.abort();
            const captures = [];
            try {
                for (let i = 0; i < frames; i++) {
                    if (controller.signal.aborted)
                        fail('CANCELLED', 'Model sampling cancelled');
                    const time = from + (to - from) * (frames === 1 ? 0 : i / (frames - 1));
                    const capture = await this.bridges.request(session.bridge, 'model.capture', { ...args, project: session.project, time, play: false });
                    if (controller.signal.aborted)
                        fail('CANCELLED', 'Model sampling cancelled');
                    captures.push(capture);
                }
                return { session: session.id, clip: args.clip, captures };
            }
            finally {
                this.controllers.delete(session.id);
                args.signal?.removeEventListener('abort', abort);
            }
        }
        if (action === 'close') {
            await this.bridges.request(session.bridge, 'model.close', { project: session.project });
            this.sessions.delete(session.id);
            for (const watcher of this.watchers.get(session.id) || [])
                watcher.close();
            this.watchers.delete(session.id);
            this.sources.delete(session.id);
            return { closed: true };
        }
        if (action === 'observe')
            action = 'inspect';
        if (action === 'watch')
            return { session: session.id, watching: true, ...await this.sourceStatus(session) };
        const source = action === 'reload' ? await readModelSource(session.path, args.assetRoot || session.assetRoot) : undefined;
        const result = await this.bridges.request(session.bridge, `model.${action}`, { ...args, project: session.project, path: session.path, ...(source ? { sourceText: source.sourceText } : {}) });
        if (action === 'camera')
            session.camera = { position: { x: result.position[0], y: result.position[1], z: result.position[2] }, target: { x: result.target[0], y: result.target[1], z: result.target[2] } };
        if (action === 'reload' && result.project) {
            session.project = result.project;
            this.watchSource(session, source);
            if (session.camera)
                await this.bridges.request(session.bridge, 'model.camera', { project: session.project, ...session.camera });
        }
        return { ...result, ...await this.sourceStatus(session) };
    }
    async close() { for (const controller of this.controllers.values())
        controller.abort(); for (const watchers of this.watchers.values())
        for (const watcher of watchers)
            watcher.close(); this.watchers.clear(); this.sources.clear(); this.sessions.clear(); }
}
//# sourceMappingURL=models.js.map