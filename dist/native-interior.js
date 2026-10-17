import fs from 'node:fs/promises';
import path from 'node:path';
import { fail, id } from './contracts.js';
import { checkInterior, loadInspection } from './interior/index.js';
import { CollisionResolver } from './maps/types.js';
import { renderSlice } from './maps/render.js';
/** Snapshot actual client collision shapes, without guessing newer-version block geometry. */
export async function inspectNative(bridges, args, artifactDir) {
    const inspection = await loadInspection(args.inspection || args.plan);
    const peer = bridges.peers.get(args.client);
    if (!peer || peer.kind !== 'fabric')
        fail('CLIENT_REQUIRED', 'Pass --client ID for an attached Fabric client');
    const observation = await bridges.request(peer.id, 'observe', {});
    if (!observation.connected)
        fail('NOT_CONNECTED', 'Native interior inspection requires a loaded world');
    const requestedDimension = inspection.dimension?.replace('minecraft:', '');
    const currentDimension = String(observation.dimension || observation.player?.dimension || '').replace('minecraft:', '');
    if (requestedDimension && currentDimension && requestedDimension !== currentDimension)
        fail('DIMENSION_MISMATCH', 'Client is in a different dimension');
    const blocks = new Map(), b = inspection.bounds;
    let firstTick, lastTick;
    for (let y = b.min.y; y <= b.max.y; y += 16)
        for (let z = b.min.z; z <= b.max.z; z += 16)
            for (let x = b.min.x; x <= b.max.x; x += 16) {
                if (args.signal?.aborted)
                    fail('CANCELLED', 'Native collision scan cancelled');
                if (args.deadline && Date.now() >= args.deadline)
                    fail('TIMEOUT', 'Native collision scan exceeded deadline');
                const result = await bridges.request(peer.id, 'blocks', { min: { x, y, z }, max: { x: Math.min(x + 15, b.max.x), y: Math.min(y + 15, b.max.y), z: Math.min(z + 15, b.max.z) }, ...(args.deadline ? { timeoutMs: Math.max(1, args.deadline - Date.now()) } : {}) });
                if (!Array.isArray(result.blocks))
                    fail('BRIDGE_PROTOCOL', 'Client did not return collision blocks');
                if ((result.gameVersion || result.version) !== peer.version)
                    fail('VERSION_MISMATCH', 'Native scan game version changed');
                if (requestedDimension && result.dimension && String(result.dimension).replace('minecraft:', '') !== requestedDimension)
                    fail('DIMENSION_MISMATCH', 'Native scan dimension changed');
                firstTick ??= result.tick;
                lastTick = result.tick;
                for (const block of result.blocks) {
                    const p = block.position;
                    if (!p || !['x', 'y', 'z'].every(k => Number.isInteger(p[k])))
                        fail('BRIDGE_PROTOCOL', 'Invalid block coordinate in native scan');
                    const special = /(?:^|:)(water|lava|ladder|vine|scaffolding|bubble_column|powder_snow|cobweb)$/.test(block.name || '') || block.properties?.waterlogged === 'true';
                    blocks.set(`${p.x},${p.y},${p.z}`, { ...block, properties: block.properties || {}, collisionSource: 'minecraft-client', shapes: block.known && Array.isArray(block.shapes) ? block.shapes : null, specialMovement: special ? block.name : undefined });
                }
            }
    const reader = {
        path: `client:${peer.id}`, kind: 'native-snapshot', dimension: inspection.dimension || currentDimension || 'minecraft:overworld', version: peer.version, bounds: b, warnings: ['Block collision snapshot spans multiple client ticks; entities, moving mechanisms and later world changes require live verification.'],
        async getBlock(x, y, z) { const block = blocks.get(`${x},${y},${z}`); return block?.known ? block : null; },
        metadata: () => ({ client: peer.id, version: peer.version, firstTick, lastTick, source: 'minecraft-client-block-collisions' }), changed: async () => false, close: async () => { }
    };
    const resolver = new CollisionResolver(peer.version);
    resolver.sample = async (_reader, x, y, z) => blocks.get(`${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`) || { name: 'unknown', properties: {}, position: { x, y, z }, known: false, shapes: null, reason: 'unavailable-native-chunk', collisionSource: 'unknown' };
    const report = await checkInterior(reader, resolver, inspection, async (floor, bounds) => ({ ...floor, ...await renderSlice(reader, resolver, { bounds, axis: 'y', at: floor.cutY, projection: 'floor', marker: inspection.entry, signal: args.signal }, artifactDir) }), { signal: args.signal });
    const reportPath = path.join(artifactDir, `${id('native_interior')}.json`);
    const result = { ...report, version: peer.version, dimension: reader.dimension, source: 'minecraft-client-block-collisions', snapshot: reader.metadata(), warnings: reader.warnings, actualVisitVerified: false, reportPath, observedAt: new Date().toISOString() };
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(result, null, 2));
    return result;
}
//# sourceMappingURL=native-interior.js.map