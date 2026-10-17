import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { Vector3 } from 'three';
import { fail } from './contracts.js';
import { officialUrl, verifyHash, MANIFEST_URL } from './servers/index.js';
import { stateString } from './maps/types.js';
import { defaultBlockProperties } from './maps/native-collisions.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const MAX_ENTRY = 32 * 1024 * 1024;
function safeAsset(name) { return name === 'version.json' || /^assets\/[a-z0-9_.-]+\/(?:blockstates|models|textures)\/[a-zA-Z0-9_./-]+$/.test(name) && !name.split('/').includes('..'); }
/** Read ZIP entries in place; never extract user resource packs to the filesystem. */
export class AssetArchive {
    file;
    entries = new Map();
    directory = false;
    constructor(file) {
        this.file = file;
    }
    static async open(file) {
        const archive = new AssetArchive(path.resolve(file)), stat = await fs.stat(file);
        if (stat.isDirectory()) {
            archive.directory = true;
            return archive;
        }
        const handle = await fs.open(file, 'r');
        try {
            const length = Math.min(stat.size, 65557), tail = Buffer.alloc(length);
            await handle.read(tail, 0, length, stat.size - length);
            let eocd = -1;
            for (let i = length - 22; i >= 0; i--)
                if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === length) {
                    eocd = i;
                    break;
                }
            if (eocd < 0)
                fail('INVALID_RESOURCE_PACK', 'ZIP central directory is missing');
            const size = tail.readUInt32LE(eocd + 12), offset = tail.readUInt32LE(eocd + 16);
            if (size === 0xffffffff || offset === 0xffffffff || size > 64 * 1024 * 1024 || offset + size > stat.size)
                fail('RESOURCE_PACK_TOO_LARGE', 'ZIP64 or an oversized central directory is unsupported');
            const central = Buffer.alloc(size);
            await handle.read(central, 0, size, offset);
            for (let i = 0; i + 46 <= size;) {
                if (central.readUInt32LE(i) !== 0x02014b50)
                    fail('INVALID_RESOURCE_PACK', 'Invalid ZIP entry');
                const flags = central.readUInt16LE(i + 8), method = central.readUInt16LE(i + 10), compressed = central.readUInt32LE(i + 20), entrySize = central.readUInt32LE(i + 24), nameLength = central.readUInt16LE(i + 28), extra = central.readUInt16LE(i + 30), comment = central.readUInt16LE(i + 32), local = central.readUInt32LE(i + 42);
                const name = central.subarray(i + 46, i + 46 + nameLength).toString('utf8');
                if (safeAsset(name)) {
                    if (flags & 1)
                        fail('INVALID_RESOURCE_PACK', 'Encrypted resource pack entries are unsupported');
                    if (entrySize > MAX_ENTRY || compressed > MAX_ENTRY)
                        fail('RESOURCE_PACK_TOO_LARGE', 'Asset exceeds 32 MiB', { name });
                    archive.entries.set(name, { offset: local, compressed, size: entrySize, method });
                }
                i += 46 + nameLength + extra + comment;
            }
        }
        finally {
            await handle.close();
        }
        return archive;
    }
    async read(name) {
        if (!safeAsset(name))
            fail('INVALID_ASSET_PATH', 'Invalid resource identifier');
        if (this.directory) {
            const target = path.join(this.file, ...name.split('/'));
            let resolved;
            try {
                resolved = await fs.realpath(target);
            }
            catch (error) {
                if (error.code === 'ENOENT')
                    return;
                throw error;
            }
            const rel = path.relative(await fs.realpath(this.file), resolved);
            if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`))
                fail('INVALID_ASSET_PATH', 'Resource pack symlink leaves its root');
            const stat = await fs.stat(resolved);
            if (stat.size > MAX_ENTRY)
                fail('RESOURCE_PACK_TOO_LARGE', 'Asset exceeds32 MiB');
            return fs.readFile(resolved);
        }
        const entry = this.entries.get(name);
        if (!entry)
            return;
        const handle = await fs.open(this.file, 'r');
        try {
            const header = Buffer.alloc(30);
            await handle.read(header, 0, 30, entry.offset);
            if (header.readUInt32LE(0) !== 0x04034b50)
                fail('INVALID_RESOURCE_PACK', 'Invalid local ZIP entry');
            const bytes = Buffer.alloc(entry.compressed);
            await handle.read(bytes, 0, bytes.length, entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28));
            const data = entry.method === 0 ? bytes : entry.method === 8 ? inflateRawSync(bytes, { maxOutputLength: MAX_ENTRY }) : undefined;
            if (!data || data.length !== entry.size)
                fail('INVALID_RESOURCE_PACK', 'Invalid asset compression or size', { name });
            return data;
        }
        finally {
            await handle.close();
        }
    }
}
function identifier(value, kind) { const parts = value.split(':'), namespace = parts.length > 1 ? parts[0] : 'minecraft', name = parts.length > 1 ? parts[1] : parts[0]; return `assets/${namespace}/${kind}/${name}`; }
export function matchesWhen(condition, properties, version) {
    if (!condition)
        return true;
    if (condition.OR)
        return condition.OR.some((entry) => matchesWhen(entry, properties, version));
    if (condition.AND)
        return condition.AND.every((entry) => matchesWhen(entry, properties, version));
    const parts = version?.split('.').map(Number), legacy = parts && parts[0] === 1 && (parts[1] < 21 || parts[1] === 21 && (parts[2] || 0) < 5);
    return Object.entries(condition).every(([key, value]) => { const text = String(value); if (legacy && text.startsWith('!'))
        return !text.slice(1).split('|').includes(properties[key]); return text.split('|').some(v => v.startsWith('!') ? properties[key] !== v.slice(1) : properties[key] === v); });
}
/** Normalize Java .mcmeta timings. Frame-size defaults follow the 26.3 client codec. */
export function normalizeTextureAnimation(metadata, imageWidth, imageHeight) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        fail('INVALID_TEXTURE_ANIMATION', 'Animation metadata must be an object');
    const integer = (value, name) => { if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647)
        fail('INVALID_TEXTURE_ANIMATION', `${name} must be a positive 32-bit integer`); return value; };
    integer(imageWidth, 'image width');
    integer(imageHeight, 'image height');
    const frameWidth = metadata.width === undefined ? (metadata.height === undefined ? Math.min(imageWidth, imageHeight) : imageWidth) : integer(metadata.width, 'frame width');
    const frameHeight = metadata.height === undefined ? (metadata.width === undefined ? Math.min(imageWidth, imageHeight) : imageHeight) : integer(metadata.height, 'frame height');
    if (imageWidth % frameWidth || imageHeight % frameHeight || imageWidth * imageHeight > 16 * 1024 * 1024)
        fail('INVALID_TEXTURE_ANIMATION', 'Animation frames must tile the PNG and fit the 16-megapixel preview limit');
    const columns = imageWidth / frameWidth, count = columns * (imageHeight / frameHeight), duration = integer(metadata.frametime ?? 1, 'frametime') * 50;
    if (metadata.frames !== undefined && !Array.isArray(metadata.frames))
        fail('INVALID_TEXTURE_ANIMATION', 'frames must be an array');
    if (count > 65536 || (metadata.frames?.length ?? 0) > 65536)
        fail('INVALID_TEXTURE_ANIMATION', 'Animation exceeds the 65536-frame preview limit');
    const authored = metadata.frames ?? Array.from({ length: count }, (_, index) => index);
    const frames = (authored.length ? authored : [0]).map((frame) => {
        const index = typeof frame === 'number' ? frame : frame?.index, time = typeof frame === 'number' ? duration : integer(frame?.time ?? duration / 50, 'frame time') * 50;
        if (!Number.isInteger(index) || index < 0 || index >= count)
            fail('INVALID_TEXTURE_ANIMATION', 'Frame index is outside the PNG', { index, count });
        return { index, durationMs: time };
    });
    return { frameWidth, frameHeight, columns, frames, totalDurationMs: frames.reduce((n, f) => n + f.durationMs, 0), interpolate: metadata.interpolate === true, tickMs: 50 };
}
/** Standalone pure function also injected into the browser, so tests exercise its exact clock. */
export function textureFrameAt(animation, elapsedMs) {
    let time = ((Math.floor(Math.max(0, elapsedMs) / animation.tickMs) * animation.tickMs) % animation.totalDurationMs), cursor = 0;
    for (let i = 0; i < animation.frames.length; i++) {
        const frame = animation.frames[i];
        if (time < cursor + frame.durationMs)
            return { index: frame.index, nextIndex: animation.frames[(i + 1) % animation.frames.length].index, progress: animation.interpolate ? (time - cursor) / frame.durationMs : 0 };
        cursor += frame.durationMs;
    }
    return { index: animation.frames[0].index, nextIndex: animation.frames[0].index, progress: 0 };
}
export function weightedVariantIndex(variants, position, salt = '') {
    let total = 0;
    const weights = variants.map(variant => { const n = variant?.weight ?? 1; if (!Number.isSafeInteger(n) || n < 1 || n > 2147483647)
        fail('INVALID_RESOURCE_MODEL', 'Model weights must be positive integers'); total += n; return n; });
    if (!weights.length || total > 2147483647)
        fail('INVALID_RESOURCE_MODEL', 'Empty or overflowing weighted variant list');
    const x = BigInt(Math.floor(position.x)), y = BigInt(Math.floor(position.y)), z = BigInt(Math.floor(position.z));
    // Vanilla's coordinate seed, followed by an explicit deterministic preview mix.
    // Rendering engines/RNG versions can choose a different exact Vanilla variant.
    let seed = BigInt.asIntN(64, x * 3129871n ^ z * 116129781n ^ y);
    seed = BigInt.asIntN(64, seed * seed * 42317861n + seed * 11n) >> 16n;
    for (const char of salt)
        seed = BigInt.asUintN(64, (seed ^ BigInt(char.charCodeAt(0))) * 1099511628211n);
    seed = BigInt.asUintN(64, (seed ^ (seed >> 30n)) * 0xbf58476d1ce4e5b9n);
    seed = BigInt.asUintN(64, (seed ^ (seed >> 27n)) * 0x94d049bb133111ebn);
    seed ^= seed >> 31n;
    let choice = Number(BigInt.asUintN(64, seed) % BigInt(total));
    for (let i = 0; i < weights.length; i++) {
        if (choice < weights[i])
            return i;
        choice -= weights[i];
    }
    return weights.length - 1;
}
const faces = {
    down: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]], up: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    north: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]], south: [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]],
    west: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]], east: [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]],
};
function defaultUV(side, f, t) { switch (side) {
    case 'down': return [f[0], 16 - t[2], t[0], 16 - f[2]];
    case 'up': return [f[0], f[2], t[0], t[2]];
    case 'north': return [16 - t[0], 16 - t[1], 16 - f[0], 16 - f[1]];
    case 'south': return [f[0], 16 - t[1], t[0], 16 - f[1]];
    case 'west': return [f[2], 16 - t[1], t[2], 16 - f[1]];
    default: return [16 - t[2], 16 - t[1], 16 - f[2], 16 - f[1]];
} }
function rotate(v, axis, degrees, origin, rescale = false) { const direction = axis === 'x' ? new Vector3(1, 0, 0) : axis === 'y' ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1); v.sub(origin); if (rescale) {
    const scale = 1 / Math.cos(degrees * Math.PI / 180);
    for (const a of ['x', 'y', 'z'])
        if (a !== axis)
            v[a] *= scale;
} v.applyAxisAngle(direction, degrees * Math.PI / 180).add(origin); }
export function bakeModel(model, variant, textureId) {
    const result = [];
    for (const element of model.elements || []) {
        const from = element.from || [0, 0, 0], to = element.to || [16, 16, 16];
        if (![...from, ...to].every(Number.isFinite))
            fail('INVALID_RESOURCE_MODEL', 'Model coordinates must be finite');
        for (const [side, face] of Object.entries(element.faces || {})) {
            if (!faces[side] || face.texture === null)
                continue;
            let ref = face.texture;
            const seen = new Set();
            while (typeof ref === 'string' && ref.startsWith('#')) {
                if (seen.has(ref))
                    break;
                seen.add(ref);
                ref = model.textures?.[ref.slice(1)];
            }
            const uv = face.uv || defaultUV(side, from, to), quadUV = [[uv[0], uv[1]], [uv[0], uv[3]], [uv[2], uv[3]], [uv[2], uv[1]]];
            const steps = ((face.rotation || 0) / 90) % 4;
            for (let i = 0; i < steps; i++)
                quadUV.push(quadUV.shift());
            const vertices = faces[side].map(c => new Vector3(...c.map((n, k) => (n ? to[k] : from[k]) / 16)));
            for (const vertex of vertices) {
                if (element.rotation)
                    rotate(vertex, element.rotation.axis, element.rotation.angle, new Vector3(...element.rotation.origin.map((n) => n / 16)), element.rotation.rescale);
                rotate(vertex, 'x', -(variant.x || 0), new Vector3(.5, .5, .5));
                rotate(vertex, 'y', -(variant.y || 0), new Vector3(.5, .5, .5));
            }
            let appliedUV = quadUV;
            if (variant.uvlock && (variant.x || variant.y)) {
                const canonical = faces[side].map(c => new Vector3(...c)), normal = canonical[1].clone().sub(canonical[0]).cross(canonical[2].clone().sub(canonical[0])).normalize();
                rotate(normal, 'x', -(variant.x || 0), new Vector3());
                rotate(normal, 'y', -(variant.y || 0), new Vector3());
                const targetSide = Object.entries(faces).find(([, corners]) => { const p = corners.map(c => new Vector3(...c)), n = p[1].clone().sub(p[0]).cross(p[2].clone().sub(p[0])).normalize(); return n.distanceTo(normal) < .001; })[0];
                const target = faces[targetSide].map(c => new Vector3(...c)), sourceU = canonical[3].clone().sub(canonical[0]), sourceV = canonical[1].clone().sub(canonical[0]), targetU = target[3].clone().sub(target[0]), targetV = target[1].clone().sub(target[0]);
                appliedUV = quadUV.map(([u, v]) => { const point = canonical[0].clone().addScaledVector(sourceU, u / 16).addScaledVector(sourceV, v / 16); rotate(point, 'x', -(variant.x || 0), new Vector3(.5, .5, .5)); rotate(point, 'y', -(variant.y || 0), new Vector3(.5, .5, .5)); point.sub(target[0]); return [point.dot(targetU) * 16, point.dot(targetV) * 16].map(n => Math.abs(n) < 1e-10 ? 0 : n); });
            }
            result.push({ positions: [0, 1, 2, 0, 2, 3].flatMap(i => vertices[i].toArray()), uv: [0, 1, 2, 0, 2, 3].flatMap(i => [appliedUV[i][0] / 16, 1 - appliedUV[i][1] / 16]), texture: textureId(typeof ref === 'string' && !ref.startsWith('#') ? ref : 'minecraft:missingno'), ...(face.tintindex === undefined ? {} : { tint: face.tintindex }) });
        }
    }
    return result;
}
export class ResourceManager {
    stateDir;
    banks = new Map();
    constructor(stateDir) {
        this.stateDir = stateDir;
    }
    async baseJar(version, args) {
        if (args.assetsJar)
            return path.resolve(args.assetsJar);
        const cached = path.resolve(`work/fabric-tools/minecraft-${version}.jar`);
        try {
            if ((await fs.stat(cached)).isFile())
                return cached;
        }
        catch { }
        const file = path.join(this.stateDir, 'assets', version, 'client.jar');
        try {
            if ((await fs.stat(file)).isFile())
                return file;
        }
        catch { }
        const signal = args.signal ? AbortSignal.any([args.signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000);
        const get = async (url) => { officialUrl(url); const response = await fetch(url, { signal, redirect: 'error' }); if (!response.ok)
            fail('ASSETS_DOWNLOAD_FAILED', `Official asset metadata HTTP ${response.status}`); return response; };
        const manifest = await (await get(MANIFEST_URL)).json(), entry = manifest.versions.find((v) => v.id === version && v.type === 'release');
        if (!entry)
            fail('VERSION_NOT_FOUND', 'No exact release assets available', { version });
        const metaBytes = Buffer.from(await (await get(entry.url)).arrayBuffer());
        verifyHash(metaBytes, entry.sha1);
        const meta = JSON.parse(metaBytes.toString('utf8')), download = meta.downloads.client;
        const response = await get(download.url), chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
            if (args.signal?.aborted)
                fail('CANCELLED', 'Asset download cancelled');
            size += chunk.length;
            if (size > Math.min(download.size + 1024, 512 * 1024 * 1024))
                fail('ASSETS_TOO_LARGE', 'Official asset archive exceeds declared size');
            chunks.push(Buffer.from(chunk));
        }
        const bytes = Buffer.concat(chunks);
        verifyHash(bytes, download.sha1);
        await fs.mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, bytes);
            if (args.signal?.aborted)
                fail('CANCELLED', 'Asset download cancelled');
            try {
                await fs.rename(temporary, file);
            }
            catch (error) {
                const existing = await fs.readFile(file).catch(() => undefined);
                if (!existing)
                    throw error;
                verifyHash(existing, download.sha1);
            }
        }
        finally {
            await fs.unlink(temporary).catch(() => { });
        }
        return file;
    }
    async bank(version, args) {
        const packs = Array.isArray(args.resourcePacks) ? args.resourcePacks : args.resourcePack ? [args.resourcePack] : [];
        const base = await this.baseJar(version, args), baseArchive = await AssetArchive.open(base), versionData = await baseArchive.read('version.json');
        if (!versionData || JSON.parse(versionData.toString('utf8')).id !== version)
            fail('ASSET_VERSION_MISMATCH', 'Client assets must match the exact map version', { version, base });
        const paths = [base, ...packs.map((p) => path.resolve(p))];
        const stats = await Promise.all(paths.map(async (p) => { const s = await fs.stat(p); return `${p}:${s.mtimeMs}:${s.size}`; }));
        // Folder packs may change files without changing the root folder timestamp;
        // reopen them so map reload/repeated captures observe resource edits.
        const key = JSON.stringify(stats), directory = await Promise.all(paths.map(p => fs.stat(p)));
        if (directory.some(s => s.isDirectory()))
            this.banks.delete(key);
        if (!this.banks.has(key))
            this.banks.set(key, Promise.all(paths.reverse().map(p => AssetArchive.open(p))).then(sources => ({ sources, models: new Map(), textures: new Map(), warnings: new Set() })));
        return this.banks.get(key);
    }
    async read(bank, name) { for (const source of bank.sources) {
        const bytes = await source.read(name);
        if (bytes)
            return bytes;
    } }
    async json(bank, name) { const bytes = await this.read(bank, name); if (!bytes)
        return; try {
        return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    }
    catch {
        fail('INVALID_RESOURCE_JSON', 'Resource pack contains invalid JSON', { name });
    } }
    async model(bank, id, stack = new Set()) {
        if (bank.models.has(id))
            return bank.models.get(id);
        if (stack.has(id) || stack.size > 32)
            fail('RESOURCE_PARENT_CYCLE', 'Cyclic model parent', { id });
        stack.add(id);
        const own = await this.json(bank, identifier(id, 'models') + '.json');
        if (!own) {
            bank.warnings.add(`Missing model: ${id}`);
            return {};
        }
        const parent = own.parent && !own.parent.startsWith('builtin/') ? await this.model(bank, own.parent, new Set(stack)) : {};
        const model = { ...parent, ...own, textures: { ...parent.textures, ...own.textures }, elements: own.elements ?? parent.elements };
        bank.models.set(id, model);
        return model;
    }
    async prepare(data, args = {}) {
        if (!data.version)
            fail('VERSION_REQUIRED', 'Texture preview needs the exact game version');
        const bank = await this.bank(data.version, args), models = {}, textures = {}, modelAssignments = {};
        const states = new Map();
        for (const block of data.blocks)
            states.set(stateString({ ...block, properties: block.properties ?? {} }), block);
        const blocksByPosition = new Map(data.blocks.map((block) => { const p = block.position ?? block.pos ?? block; return [`${p.x},${p.y},${p.z}`, block]; }));
        const plans = new Map();
        let weightedParts = 0;
        for (const [key, rawState] of states) {
            if (['minecraft:water', 'minecraft:lava'].includes(rawState.name))
                continue;
            let defaults = defaultBlockProperties(data.version, rawState.name);
            if (!Object.keys(defaults).length) {
                try {
                    const md = require('minecraft-data')(data.version), Block = require('prismarine-block')(data.version), definition = md.blocksByName[rawState.name.replace('minecraft:', '')];
                    if (definition)
                        defaults = Block.fromStateId(definition.defaultState, 0).getProperties();
                }
                catch { }
            }
            const state = { ...rawState, properties: Object.fromEntries(Object.entries({ ...defaults, ...rawState.properties }).map(([key, value]) => [key, String(value)])) };
            if (args.signal?.aborted)
                fail('CANCELLED', 'Resource preparation cancelled');
            const definition = await this.json(bank, identifier(state.name, 'blockstates') + '.json');
            if (!definition) {
                bank.warnings.add(`No blockstate model: ${state.name}`);
                continue;
            }
            const parts = [];
            if (definition.variants)
                for (const [condition, variant] of Object.entries(definition.variants)) {
                    const when = Object.fromEntries(condition.split(',').filter(Boolean).map(p => p.split('=')));
                    if (matchesWhen(when, state.properties || {}, data.version)) {
                        parts.push(Array.isArray(variant) ? variant : [variant]);
                        break;
                    }
                }
            for (const part of definition.multipart || [])
                if (matchesWhen(part.when, state.properties || {}, data.version))
                    parts.push(Array.isArray(part.apply) ? part.apply : [part.apply]);
            weightedParts += parts.filter(part => part.length > 1).length;
            plans.set(key, parts);
        }
        for (const block of data.blocks) {
            if (args.signal?.aborted)
                fail('CANCELLED', 'Resource preparation cancelled');
            const key = stateString({ ...block, properties: block.properties ?? {} }), p = block.position ?? block.pos ?? block;
            if (['minecraft:water', 'minecraft:lava'].includes(block.name)) {
                const fluid = block.name.slice(10), level = Number(block.properties?.level ?? 0), above = blocksByPosition.get(`${p.x},${p.y + 1},${p.z}`), height = above?.name === block.name || level >= 8 ? 1 : (8 - Math.min(7, Math.max(0, level))) / 9;
                const visible = Object.entries({ up: [0, 1, 0], down: [0, -1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] }).filter(([side, offset]) => { const adjacent = blocksByPosition.get(`${p.x + offset[0]},${p.y + offset[1]},${p.z + offset[2]}`); if (adjacent?.name !== block.name)
                    return true; if (side === 'up' || side === 'down')
                    return false; const adjacentLevel = Number(adjacent.properties?.level ?? 0); return adjacentLevel < 8 && (8 - Math.min(7, Math.max(0, adjacentLevel))) / 9 < height; }).map(([side]) => side);
                const geometryKey = `${key}#fluid-${height}-${visible.join('.')}`;
                if (!models[geometryKey])
                    models[geometryKey] = bakeModel({ elements: [{ from: [0, 0, 0], to: [16, height * 16, 16], faces: Object.fromEntries(visible.map(side => [side, { texture: `minecraft:block/${fluid}_${side === 'up' || side === 'down' ? 'still' : 'flow'}`, ...(fluid === 'water' ? { tintindex: 0 } : {}) }])) }] }, {}, ref => ref);
                modelAssignments[`${p.x},${p.y},${p.z}`] = geometryKey;
                continue;
            }
            const parts = plans.get(key);
            if (!parts)
                continue;
            const indices = parts.map((choices, i) => weightedVariantIndex(choices, p, `${key}:${i}`));
            const geometryKey = parts.some(part => part.length > 1) ? `${key}#${indices.join('.')}` : key;
            if (!models[geometryKey]) {
                if (Object.keys(models).length > 4096)
                    fail('RESOURCE_VARIANT_LIMIT', 'Preview has too many distinct model combinations; use smaller bounds');
                const baked = [];
                for (let i = 0; i < parts.length; i++) {
                    const variant = parts[i][indices[i]];
                    if (!variant?.model)
                        continue;
                    const model = await this.model(bank, variant.model);
                    baked.push(...bakeModel(model, variant, ref => ref));
                }
                if (!baked.length) {
                    bank.warnings.add(`No static model geometry: ${key}`);
                    continue;
                }
                models[geometryKey] = baked;
                if (!models[key])
                    models[key] = baked;
            }
            if (geometryKey !== key)
                modelAssignments[`${p.x},${p.y},${p.z}`] = geometryKey;
        }
        for (const texture of new Set(Object.values(models).flatMap(faces => faces.map(face => face.texture)))) {
            const name = identifier(texture, 'textures') + '.png';
            let bytes, metadata;
            // Sprite metadata belongs to the same pack as its PNG; a higher PNG
            // without .mcmeta must not inherit an animation from a lower pack.
            for (const source of bank.sources) {
                bytes = await source.read(name);
                if (bytes) {
                    const raw = await source.read(name + '.mcmeta');
                    if (raw)
                        try {
                            metadata = JSON.parse(raw.toString('utf8'));
                        }
                        catch {
                            fail('INVALID_RESOURCE_JSON', 'Invalid texture metadata', { name });
                        }
                    break;
                }
            }
            if (!bytes) {
                bank.warnings.add(`Missing texture: ${texture}`);
                continue;
            }
            let animation;
            if (metadata?.animation) {
                if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
                    fail('INVALID_TEXTURE_ANIMATION', 'Animated texture must be a PNG', { texture });
                animation = normalizeTextureAnimation(metadata.animation, bytes.readUInt32BE(16), bytes.readUInt32BE(20));
            }
            textures[texture] = { url: `data:image/png;base64,${bytes.toString('base64')}`, sha256: createHash('sha256').update(bytes).digest('hex'), animation };
        }
        return { models, modelAssignments, textures, source: 'java-resource-model-preview', approximate: true, resourcePacks: bank.sources.map(s => s.file), warnings: [...bank.warnings], fidelity: { renderer: 'three-resource-preview', exactGamePixels: false, textureAnimations: 'java-mcmeta-20hz', weightedModels: 'deterministic-position-seed', weightedParts, fluids: 'level-height-mesh-neighbor-culling' }, limitations: ['Preview shaders, lighting, transparency and biome blending differ from Minecraft.', 'Weighted alternatives use coordinate-seeded preview RNG; exact engine choices require Fabric capture.', 'Fluid heights use state levels and neighboring fluid culling; flow slopes/refraction differ from Minecraft.', 'Entity and block-entity previews are labelled proxies; actual game capture remains authoritative.'] };
    }
}
//# sourceMappingURL=resources.js.map