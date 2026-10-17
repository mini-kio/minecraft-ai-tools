import { createRequire } from 'node:module';
import { fail } from '../contracts.js';
import { nativeCollisionData, nativeStateKey } from './native-collisions.js';
const require = createRequire(import.meta.url);
export const AIR = { name: 'minecraft:air', properties: {} };
export function point(value, name = 'position') {
    const p = Array.isArray(value) ? { x: value[0], y: value[1], z: value[2] } : value;
    if (!p || !['x', 'y', 'z'].every(k => typeof p[k] === 'number' && Number.isFinite(p[k])))
        fail('INVALID_ARGUMENT', `${name} must contain finite x, y and z numbers`);
    if (!['x', 'y', 'z'].every(k => p[k] >= -2_147_483_648 && p[k] <= 2_147_483_647))
        fail('INVALID_ARGUMENT', `${name} coordinates must lie within the signed 32-bit block coordinate range`);
    return { x: p.x, y: p.y, z: p.z };
}
export function bounds(value, fallback, limit = 1_000_000) {
    if (!value && fallback)
        value = fallback;
    if (!value)
        fail('INVALID_ARGUMENT', 'bounds is required');
    const b = { min: point(value.min, 'bounds.min'), max: point(value.max, 'bounds.max') };
    for (const axis of ['x', 'y', 'z']) {
        if (!Number.isSafeInteger(b.min[axis]) || !Number.isSafeInteger(b.max[axis]) || b.min[axis] > b.max[axis])
            fail('INVALID_ARGUMENT', 'bounds use inclusive integer block coordinates with min <= max');
    }
    if (volume(b) > limit)
        fail('BOUNDS_TOO_LARGE', `Requested region exceeds ${limit} blocks; select a smaller bounds`, { bounds: b, volume: volume(b) });
    return b;
}
export function volume(b) { return (b.max.x - b.min.x + 1) * (b.max.y - b.min.y + 1) * (b.max.z - b.min.z + 1); }
export function contains(b, p) { return p.x >= b.min.x && p.x < b.max.x + 1 && p.y >= b.min.y && p.y < b.max.y + 1 && p.z >= b.min.z && p.z < b.max.z + 1; }
export function state(text) {
    // Modern mixed NBT lists wrap primitive palette entries in an empty-name
    // compound. Stateful entries use id/properties instead of Name/Properties.
    while (text && typeof text === 'object' && Object.keys(text).length === 1 && Object.hasOwn(text, ''))
        text = text[''];
    if (typeof text !== 'string') {
        const name = text?.Name ?? text?.id ?? text?.name;
        if (typeof name !== 'string' || !name)
            fail('INVALID_BLOCK_STATE', 'Block palette entry has no valid resource identifier');
        const properties = text.Properties ?? text.properties ?? {};
        if (!properties || typeof properties !== 'object' || Array.isArray(properties))
            fail('INVALID_BLOCK_STATE', 'Block state properties must be an object');
        return { name: name.includes(':') ? name : `minecraft:${name}`, properties: Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, String(v)])) };
    }
    const [name, tail] = text.split('[');
    const properties = Object.fromEntries((tail?.replace(/\]$/, '').split(',') ?? []).filter(Boolean).map(pair => pair.split('=')));
    return { name: name.includes(':') ? name : `minecraft:${name}`, properties };
}
export function stateString(s) { const props = Object.entries(s.properties).sort().map(([k, v]) => `${k}=${v}`).join(','); return s.name + (props ? `[${props}]` : ''); }
/** Collision shapes are resolved from the selected Java version, never guessed as full cubes. */
export class CollisionResolver {
    version;
    Block;
    data;
    native;
    cache = new Map();
    constructor(version) {
        this.version = version;
        this.native = nativeCollisionData(version);
        try {
            if (version) {
                this.data = require('minecraft-data')(version);
                if (this.data)
                    this.Block = require('prismarine-block')(version);
            }
        }
        catch { /* An unsupported version remains explicit unknown. */ }
    }
    get available() { return !!this.native || !!this.Block; }
    normalize(s) { return { name: s.name, properties: { ...this.native?.defaults.get(s.name), ...s.properties } }; }
    describe(s) {
        s = this.normalize(s);
        const key = stateString(s);
        const cached = this.cache.get(key);
        if (cached)
            return cached;
        let result = { shapes: null, collisionSource: 'unknown' };
        const name = s.name.replace(/^minecraft:/, '');
        if (['air', 'cave_air', 'void_air'].includes(name))
            result = { shapes: [], collisionSource: 'empty-air' };
        else if (this.native?.states.has(nativeStateKey(s))) {
            const record = this.native.states.get(nativeStateKey(s));
            result = { shapes: record.shapes, collisionSource: record.shapes === null ? 'native-context-required' : `fabric-registry:${this.version}` };
        }
        else if (s.name.startsWith('minecraft:') && this.Block && this.data.blocksByName[name]) {
            const definition = this.data.blocksByName[name];
            const values = {};
            let valid = true;
            for (const prop of definition.states ?? []) {
                // A partial state must use Minecraft's default, rather than the first state permutation.
                const defaultProperties = this.Block.fromStateId(definition.defaultState, 0).getProperties();
                const raw = s.properties[prop.name] ?? String(defaultProperties[prop.name]);
                if (prop.type === 'bool') {
                    if (!['true', 'false'].includes(raw))
                        valid = false;
                    values[prop.name] = raw === 'true';
                }
                else if (prop.type === 'int' && !prop.values) {
                    const n = Number(raw);
                    if (!Number.isInteger(n) || n < 0 || n >= prop.num_values)
                        valid = false;
                    values[prop.name] = n;
                }
                else {
                    if (prop.values && !prop.values.map(String).includes(raw))
                        valid = false;
                    values[prop.name] = raw;
                }
            }
            if (Object.keys(s.properties).some(k => !(definition.states ?? []).some((p) => p.name === k)))
                valid = false;
            if (valid) {
                try {
                    const block = this.Block.fromProperties(name, values, 0);
                    if (!block.missingStateShape && Array.isArray(block.shapes))
                        result = { shapes: block.shapes.map((shape) => [...shape]), collisionSource: `prismarine-block:${this.version}` };
                }
                catch { /* Invalid or missing shapes remain unknown. */ }
            }
        }
        if (['water', 'lava', 'bubble_column', 'ladder', 'vine', 'scaffolding', 'weeping_vines', 'twisting_vines', 'powder_snow', 'cobweb'].includes(name) || s.properties.waterlogged === 'true')
            result.specialMovement = name;
        if (name === 'structure_void')
            result = { shapes: null, collisionSource: 'unknown-structure-void' };
        this.cache.set(key, result);
        return result;
    }
    async sample(reader, x, y, z) {
        x = Math.floor(x);
        y = Math.floor(y);
        z = Math.floor(z);
        const s = await reader.getBlock(x, y, z);
        if (!s)
            return { name: 'unknown', properties: {}, position: { x, y, z }, known: false, reason: 'outside-source-or-unavailable-chunk', shapes: null, collisionSource: 'unknown' };
        const collision = { ...this.describe(s) };
        if (collision.shapes === null && this.native) {
            const normalized = this.normalize(s);
            for (const entry of this.native.cases) {
                if (entry.shapeContext !== 'empty' || entry.dimension !== reader.dimension || entry.position.x !== x || entry.position.y !== y || entry.position.z !== z || nativeStateKey(entry.state) !== nativeStateKey(normalized) || Object.keys(entry.environment || {}).length)
                    continue;
                let match = true;
                for (const dependency of entry.dependencies || []) {
                    if (dependency.kind !== 'block') {
                        match = false;
                        break;
                    }
                    const d = dependency.offset, state = await reader.getBlock(x + d.x, y + d.y, z + d.z);
                    if (!state || nativeStateKey(this.normalize(state)) !== nativeStateKey(this.normalize(dependency.expectedState))) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    collision.shapes = entry.shapes;
                    collision.collisionSource = `fabric-traced-context:${this.version}`;
                    break;
                }
            }
        }
        return { ...this.normalize(s), position: { x, y, z }, known: true, ...collision, ...(collision.shapes === null ? { reason: 'unresolved-block-collision' } : {}) };
    }
}
//# sourceMappingURL=types.js.map