import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fail } from '../contracts.js';
function key(state) { return state.name + '[' + Object.entries(state.properties || {}).sort().map(([k, v]) => k + '=' + v).join(',') + ']'; }
const cached = new Map();
const extraDirectories = new Set();
export function registerCollisionDirectory(directory) { extraDirectories.add(path.resolve(directory)); }
export function nativeCollisionData(version) {
    if (!version || !/^[0-9]+(?:\.[0-9]+){1,2}$/.test(version))
        return;
    const candidates = [...extraDirectories].reverse().map(dir => path.join(dir, version + '.json.gz'));
    candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bridges/fabric/collision-data', version + '.json.gz'));
    const file = candidates.find(file => { try {
        return statSync(file).isFile();
    }
    catch {
        return false;
    } });
    if (!file)
        return;
    let stat;
    try {
        stat = statSync(file);
    }
    catch {
        return;
    }
    const stamp = file + ':' + stat.mtimeMs + ':' + stat.size, previous = cached.get(version);
    if (previous?.stamp === stamp)
        return previous.data;
    const compressed = readFileSync(file), metadata = JSON.parse(readFileSync(file + '.metadata.json', 'utf8'));
    if (createHash('sha256').update(compressed).digest('hex') !== metadata.sha256)
        fail('COLLISION_INTEGRITY_FAILED', 'Bundled native collision dataset failed checksum', { version });
    const raw = JSON.parse(gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 }).toString('utf8'));
    if (raw.schemaVersion !== 1 || raw.gameVersion !== version || raw.shapeContext !== 'empty')
        fail('INVALID_COLLISION_DATA', 'Collision dataset version or walking context differs', { version });
    const data = { version, fingerprint: raw.registryFingerprint, defaults: new Map(raw.defaultStates.map((state) => [state.name, state.properties])), states: new Map(raw.states.map((state) => [key(state), { shapes: state.shapes, reason: state.reason }])), cases: raw.contextCases || [] };
    cached.set(version, { stamp, data });
    return data;
}
export function nativeStateKey(state) { return key(state); }
export function defaultBlockProperties(version, name) { return nativeCollisionData(version)?.defaults.get(name) || {}; }
//# sourceMappingURL=native-collisions.js.map