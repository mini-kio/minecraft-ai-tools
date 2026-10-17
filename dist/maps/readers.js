import { createRequire } from 'node:module';
import { open, readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import { fail, ToolError } from '../contracts.js';
import { AIR, state, contains } from './types.js';
import { parseMapEntities, parseMapBlockEntities, entityView, entityInBounds, tag } from './entities.js';
import { decodeAnvilLz4 } from './lz4.js';
const require = createRequire(import.meta.url);
const nbt = require('prismarine-nbt');
const MAX_FILE = 128 * 1024 * 1024;
async function decode(buffer) {
    try {
        return nbt.simplify((await nbt.parse(buffer, 'big')).parsed);
    }
    catch (e) {
        fail('INVALID_NBT', 'Cannot read Java big-endian NBT', { reason: String(e) });
    }
}
export async function readTypedMapNbt(path) {
    const s = await stat(path);
    if (s.size > MAX_FILE)
        fail('FILE_TOO_LARGE', 'NBT file exceeds 128 MiB');
    let raw = await readFile(path);
    if (raw[0] === 0x1f && raw[1] === 0x8b)
        raw = gunzipSync(raw, { maxOutputLength: MAX_FILE });
    try {
        return (await nbt.parse(raw, 'big')).parsed;
    }
    catch (e) {
        fail('INVALID_NBT', 'Cannot read Java big-endian NBT', { reason: String(e) });
    }
}
async function fileNbt(path) { return nbt.simplify(await readTypedMapNbt(path)); }
function versionFor(dataVersion, explicit) {
    if (explicit) {
        const requested = require('minecraft-data')(explicit);
        if (dataVersion && requested?.version?.dataVersion && requested.version.dataVersion !== dataVersion)
            fail('VERSION_MISMATCH', 'Requested game version disagrees with the source DataVersion', { requestedVersion: explicit, requestedDataVersion: requested.version.dataVersion, sourceDataVersion: dataVersion });
        return explicit;
    }
    if (!dataVersion)
        return undefined;
    const versions = require('minecraft-data').versions.pc;
    return versions.find(v => v.dataVersion === dataVersion && !/[a-z]/i.test(v.minecraftVersion))?.minecraftVersion;
}
function signature(s) { return `${s.size}:${s.mtimeMs}`; }
function positive(n, name) { if (!Number.isInteger(n) || n < 1 || n > 32768)
    fail('INVALID_NBT', `${name} must be between 1 and 32768`); return n; }
function readVarints(data, count) {
    const result = new Uint32Array(count);
    let offset = 0;
    for (let i = 0; i < count; i++) {
        let value = 0;
        let shift = 0;
        for (;;) {
            if (offset >= data.length || shift > 28)
                fail('INVALID_SCHEMATIC', 'Truncated or oversized block palette varint', { index: i });
            const byte = data[offset++] & 255;
            value |= (byte & 127) << shift;
            if (!(byte & 128))
                break;
            shift += 7;
        }
        result[i] = value >>> 0;
    }
    if (offset !== data.length)
        fail('INVALID_SCHEMATIC', 'Unexpected trailing block palette data');
    return result;
}
class SchematicReader {
    path;
    kind = 'schematic';
    dimension = 'minecraft:overworld';
    bounds;
    warnings = [];
    version;
    dataVersion;
    sourceSignature = '';
    palette = [];
    indices;
    width = 0;
    height = 0;
    length = 0;
    offset = [0, 0, 0];
    constructor(path) {
        this.path = path;
    }
    entities = [];
    blockEntities = [];
    static async load(path, version) {
        const reader = new SchematicReader(path);
        const typed = await readTypedMapNbt(path);
        const root = nbt.simplify(typed);
        const s = root.Schematic ?? root;
        reader.sourceSignature = signature(await stat(path));
        reader.dataVersion = s.DataVersion;
        reader.version = versionFor(s.DataVersion, version);
        if (s.Version !== undefined && ![1, 2, 3].includes(s.Version))
            fail('UNSUPPORTED_SCHEMATIC_VERSION', `Sponge schematic version ${s.Version} is not supported`);
        reader.width = positive(s.Width, 'Width');
        reader.height = positive(s.Height, 'Height');
        reader.length = positive(s.Length, 'Length');
        const count = reader.width * reader.height * reader.length;
        if (count > 8_000_000)
            fail('BOUNDS_TOO_LARGE', 'Schematic exceeds 8 million blocks');
        const palette = s.Blocks?.Palette ?? s.Palette;
        const data = s.Blocks?.Data ?? s.BlockData;
        if (!palette || !data)
            fail('INVALID_SCHEMATIC', 'Expected Sponge Palette/BlockData or Blocks.Palette/Blocks.Data');
        const seen = new Set();
        for (const [key, value] of Object.entries(palette)) {
            if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > count + 65536 || seen.has(Number(value)))
                fail('INVALID_SCHEMATIC', 'Palette IDs must be unique nonnegative integers');
            reader.palette[Number(value)] = state(key);
            seen.add(Number(value));
        }
        reader.indices = readVarints(data, count);
        for (const index of reader.indices)
            if (!reader.palette[index])
                fail('INVALID_SCHEMATIC', `Missing palette entry ${index}`);
        if (s.Offset !== undefined) {
            if (!Array.isArray(s.Offset) || s.Offset.length !== 3 || !s.Offset.every(Number.isInteger))
                fail('INVALID_SCHEMATIC', 'Offset must contain exactly three integers');
            reader.offset = s.Offset.map(Number);
        }
        const [x, y, z] = reader.offset;
        reader.bounds = { min: { x, y, z }, max: { x: x + reader.width - 1, y: y + reader.height - 1, z: z + reader.length - 1 } };
        reader.entities = parseMapEntities(typed, 'schematic', reader.bounds.min);
        reader.blockEntities = parseMapBlockEntities(typed, 'schematic', reader.bounds.min);
        reader.warnings.push('Schematic Offset is used as its coordinate origin. Entity NBT is exposed read-only; simulation and exact entity rendering require native staging.');
        if (!reader.version)
            reader.warnings.push('Game version is unresolved; pass --version for version-specific collision shapes.');
        return reader;
    }
    async getBlock(x, y, z) { x -= this.offset[0]; y -= this.offset[1]; z -= this.offset[2]; return x < 0 || y < 0 || z < 0 || x >= this.width || y >= this.height || z >= this.length ? null : this.palette[this.indices[x + z * this.width + y * this.width * this.length]]; }
    async getEntities(b, signal) { if (signal?.aborted)
        fail('CANCELLED', 'Entity read cancelled'); return this.entities.filter(e => entityInBounds(e, b)).map(entityView); }
    async getBlockEntities(b, signal) { if (signal?.aborted)
        fail('CANCELLED', 'Block entity read cancelled'); return this.blockEntities.filter(e => contains(b, e.position)); }
    async getEnvironment() { return { known: false, reason: 'portable-source-has-no-saved-light-or-biome' }; }
    metadata() { return { format: 'sponge', origin: this.offset, paletteSize: this.palette.length }; }
    async changed() { return signature(await stat(this.path)) !== this.sourceSignature; }
    async close() { }
}
class StructureReader {
    path;
    kind = 'structure';
    dimension = 'minecraft:overworld';
    bounds;
    version;
    dataVersion;
    warnings = ['Structure entities and block entities are not simulated. Omitted block entries are unknown, because structure voids do not establish air.'];
    blocks = new Map();
    sourceSignature = '';
    constructor(path) {
        this.path = path;
    }
    entities = [];
    blockEntities = [];
    static async load(path, version) {
        const r = new StructureReader(path);
        const typed = await readTypedMapNbt(path);
        const s = nbt.simplify(typed);
        if (!Array.isArray(s.size) || s.size.length !== 3 || !Array.isArray(s.blocks))
            fail('INVALID_STRUCTURE', 'Expected Java structure size, palette and blocks');
        const [x, y, z] = s.size.map((n) => positive(n, 'size'));
        if (x * y * z > 8_000_000)
            fail('BOUNDS_TOO_LARGE', 'Structure exceeds 8 million blocks');
        const palette = s.palette ?? s.palettes?.[0];
        if (!Array.isArray(palette))
            fail('INVALID_STRUCTURE', 'Missing Java block palette');
        r.bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: x - 1, y: y - 1, z: z - 1 } };
        r.dataVersion = s.DataVersion;
        r.version = versionFor(s.DataVersion, version);
        for (const block of s.blocks) {
            if (!Array.isArray(block.pos) || block.pos.length !== 3 || !block.pos.every((n, i) => Number.isInteger(n) && n >= 0 && n < s.size[i]) || !palette[block.state])
                fail('INVALID_STRUCTURE', 'Invalid Java structure block position or state');
            r.blocks.set(block.pos.join(','), state(palette[block.state]));
        }
        r.entities = parseMapEntities(typed, 'structure', r.bounds.min);
        r.blockEntities = parseMapBlockEntities(typed, 'structure', r.bounds.min);
        r.sourceSignature = signature(await stat(path));
        if (!r.version)
            r.warnings.push('Game version is unresolved; pass --version for collision shapes.');
        return r;
    }
    async getBlock(x, y, z) { if (x < 0 || y < 0 || z < 0 || x > this.bounds.max.x || y > this.bounds.max.y || z > this.bounds.max.z)
        return null; return this.blocks.get(`${x},${y},${z}`) ?? null; }
    async getEntities(b, signal) { if (signal?.aborted)
        fail('CANCELLED', 'Entity read cancelled'); return this.entities.filter(e => entityInBounds(e, b)).map(entityView); }
    async getBlockEntities(b, signal) { if (signal?.aborted)
        fail('CANCELLED', 'Block entity read cancelled'); return this.blockEntities.filter(e => contains(b, e.position)); }
    async getEnvironment() { return { known: false, reason: 'portable-source-has-no-saved-light-or-biome' }; }
    metadata() { return { format: 'java-structure', storedBlocks: this.blocks.size }; }
    async changed() { return signature(await stat(this.path)) !== this.sourceSignature; }
    async close() { }
}
function long64(v) { if (typeof v === 'bigint')
    return BigInt.asUintN(64, v); if (Array.isArray(v))
    return (BigInt(v[0] >>> 0) << 32n) | BigInt(v[1] >>> 0); fail('INVALID_CHUNK', 'Unexpected NBT long-array element'); }
async function regionPayload(file, cx, cz) {
    const h = await open(file, 'r');
    try {
        const index = ((cx % 32 + 32) % 32) + ((cz % 32 + 32) % 32) * 32, head = Buffer.alloc(4);
        if ((await h.read(head, 0, 4, index * 4)).bytesRead !== 4)
            return null;
        const location = head.readUInt32BE(), sector = location >>> 8, sectors = location & 255;
        if (!sector || !sectors)
            return null;
        const header = Buffer.alloc(5);
        if ((await h.read(header, 0, 5, sector * 4096)).bytesRead !== 5)
            return null;
        const length = header.readUInt32BE(), type = header[4];
        if (length < 1 || length > 16 * 1024 * 1024 || (!(type & 128) && length > sectors * 4096 - 4))
            fail('INVALID_REGION', 'Chunk length exceeds allocated sectors');
        let payload;
        if (type & 128) {
            const external = join(dirname(file), `c.${cx}.${cz}.mcc`);
            if ((await stat(external)).size > 16 * 1024 * 1024)
                fail('INVALID_REGION', 'External chunk exceeds 16 MiB');
            payload = await readFile(external);
        }
        else {
            payload = Buffer.alloc(length - 1);
            if ((await h.read(payload, 0, payload.length, sector * 4096 + 5)).bytesRead !== payload.length)
                fail('INVALID_REGION', 'Truncated chunk data');
        }
        const compression = type & 127;
        return compression === 1 ? gunzipSync(payload, { maxOutputLength: MAX_FILE }) : compression === 2 ? inflateSync(payload, { maxOutputLength: MAX_FILE }) : compression === 3 ? payload : compression === 4 ? decodeAnvilLz4(payload, MAX_FILE) : fail('UNSUPPORTED_COMPRESSION', `Region compression ${compression} is unavailable`);
    }
    finally {
        await h.close();
    }
}
class AnvilReader {
    path;
    kind = 'anvil';
    dimension;
    bounds;
    version;
    dataVersion;
    warnings = ['Chunk data are read lazily from disk. Running servers may save changes between observations; use a copy or reload for a consistent inspection.'];
    regions = new Map();
    chunks = new Map();
    regionDir = '';
    stats = { chunksRead: 0, cachedChunks: 0 };
    failures = new Map();
    constructor(path, dimension) {
        this.path = path;
        this.dimension = dimension;
    }
    static async load(path, version, dimension = 'minecraft:overworld') {
        const r = new AnvilReader(path, dimension);
        const isFile = (await stat(path)).isFile();
        let files;
        if (isFile) {
            r.regionDir = dirname(path);
            files = [path];
        }
        else {
            if (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(dimension) || dimension.includes('..'))
                fail('INVALID_DIMENSION', 'Use a namespaced dimension, e.g. minecraft:overworld');
            const [namespace, dimensionPath] = dimension.split(':');
            const folderName = basename(path);
            const candidates = basename(path).toLowerCase() === 'region' ? [path] : [join(path, 'dimensions', namespace, dimensionPath, 'region')];
            if (dimension === 'minecraft:overworld')
                candidates.push(join(path, 'region'));
            else if (dimension === 'minecraft:the_nether' || dimension === 'minecraft:the_end') {
                const nether = dimension === 'minecraft:the_nether', legacyFolder = nether ? 'DIM-1' : 'DIM1', suffix = nether ? '_nether' : '_the_end';
                candidates.push(join(path, legacyFolder, 'region'));
                // Paper normally separates dimensions into sibling world folders.
                const sibling = join(dirname(path), folderName + suffix);
                candidates.push(join(sibling, 'dimensions', namespace, dimensionPath, 'region'), join(sibling, legacyFolder, 'region'), join(sibling, 'region'));
                // Also accept a dimension folder passed directly, without accidentally
                // relabeling the base world's region directory as another dimension.
                if ([legacyFolder, dimensionPath].includes(folderName) || folderName.endsWith(suffix))
                    candidates.push(join(path, 'region'));
            }
            let selected = false;
            for (const candidate of [...new Set(candidates)]) {
                try {
                    if (!(await stat(candidate)).isDirectory())
                        continue;
                    r.regionDir = candidate;
                    selected = true;
                    break;
                }
                catch { /* Try the next supported world layout. */ }
            }
            if (!selected)
                fail('DIMENSION_NOT_FOUND', `No region directory for ${dimension}`, { candidates: [...new Set(candidates)] });
            files = (await readdir(r.regionDir)).filter(f => /^r\.-?\d+\.-?\d+\.mca$/.test(f)).map(f => join(r.regionDir, f));
            try {
                const level = (await fileNbt(join(path, 'level.dat'))).Data;
                r.dataVersion = level?.DataVersion;
            }
            catch { /* The region files are useful without level.dat. */ }
        }
        if (!files.length)
            fail('NO_REGIONS', 'No Anvil region files found');
        let minX = Infinity;
        let minZ = Infinity;
        let maxX = -Infinity;
        let maxZ = -Infinity;
        let firstSavedChunk;
        for (const file of files) {
            const match = /r\.(-?\d+)\.(-?\d+)\.mca$/.exec(file);
            if (!match)
                fail('INVALID_REGION_NAME', 'Anvil region filenames must be r.<regionX>.<regionZ>.mca');
            const rx = Number(match[1]);
            const rz = Number(match[2]);
            r.regions.set(`${rx},${rz}`, { path: file, signature: signature(await stat(file)) });
            // Read only the 4 KiB location table, never every chunk in the region.
            const handle = await open(file, 'r');
            const header = Buffer.alloc(4096);
            let bytes = 0;
            try {
                bytes = (await handle.read(header, 0, 4096, 0)).bytesRead;
            }
            finally {
                await handle.close();
            }
            if (bytes !== 4096) {
                r.failures.set(`${rx},${rz}`, 'truncated-region-header');
                continue;
            }
            for (let index = 0; index < 1024; index++)
                if (header.readUInt32BE(index * 4) >>> 8) {
                    const cx = rx * 32 + (index % 32);
                    const cz = rz * 32 + Math.floor(index / 32);
                    firstSavedChunk ??= { x: cx, z: cz };
                    minX = Math.min(minX, cx * 16);
                    minZ = Math.min(minZ, cz * 16);
                    maxX = Math.max(maxX, cx * 16 + 15);
                    maxZ = Math.max(maxZ, cz * 16 + 15);
                }
        }
        if (!Number.isFinite(minX))
            fail('NO_CHUNKS', 'No saved chunks found in the selected dimension');
        r.bounds = { min: { x: minX, y: dimension === 'minecraft:overworld' ? -64 : 0, z: minZ }, max: { x: maxX, y: dimension === 'minecraft:overworld' ? 319 : 255, z: maxZ } };
        // A bounding-box corner need not contain a saved chunk. Read an indexed
        // location, including when --version was supplied, so raw .mca files can
        // validate an explicit version against their actual DataVersion.
        if (!r.dataVersion && firstSavedChunk)
            await r.loadChunk(firstSavedChunk.x, firstSavedChunk.z);
        r.version = versionFor(r.dataVersion, version);
        if (!r.version)
            r.warnings.push('DataVersion is not in the installed registry; collision checks stay unknown until a supported exact version is specified.');
        return r;
    }
    async loadChunk(cx, cz) {
        const key = `${cx},${cz}`;
        const existing = this.chunks.get(key);
        if (existing)
            return existing;
        const promise = this.decodeChunk(cx, cz).catch(e => { this.failures.set(key, String(e)); return null; });
        this.chunks.set(key, promise);
        // Bound memory while allowing the common interior working set to remain hot.
        if (this.chunks.size > 256)
            this.chunks.delete(this.chunks.keys().next().value);
        this.stats.cachedChunks = this.chunks.size;
        return promise;
    }
    async decodeChunk(cx, cz) {
        const rx = Math.floor(cx / 32);
        const rz = Math.floor(cz / 32);
        const region = this.regions.get(`${rx},${rz}`);
        if (!region)
            return null;
        const h = await open(region.path, 'r');
        let raw;
        try {
            const head = Buffer.alloc(4);
            const index = ((cx % 32 + 32) % 32) + ((cz % 32 + 32) % 32) * 32;
            if ((await h.read(head, 0, 4, index * 4)).bytesRead !== 4)
                return null;
            const location = head.readUInt32BE();
            const sector = location >>> 8;
            const sectors = location & 255;
            if (!sector || !sectors)
                return null;
            const lengthHeader = Buffer.alloc(5);
            if ((await h.read(lengthHeader, 0, 5, sector * 4096)).bytesRead !== 5)
                return null;
            const length = lengthHeader.readUInt32BE();
            const type = lengthHeader[4];
            if (length < 1 || length > 16 * 1024 * 1024 || (!(type & 128) && length > sectors * 4096 - 4))
                fail('INVALID_REGION', 'Chunk length exceeds allocated sectors');
            let payload;
            if (type & 128) {
                const external = join(this.regionDir, `c.${cx}.${cz}.mcc`);
                if ((await stat(external)).size > 16 * 1024 * 1024)
                    fail('INVALID_REGION', 'External chunk exceeds 16 MiB');
                payload = await readFile(external);
            }
            else {
                payload = Buffer.alloc(length - 1);
                if ((await h.read(payload, 0, payload.length, sector * 4096 + 5)).bytesRead !== payload.length)
                    fail('INVALID_REGION', 'Truncated chunk data');
            }
            const compression = type & 127;
            if (compression === 1)
                raw = gunzipSync(payload, { maxOutputLength: MAX_FILE });
            else if (compression === 2)
                raw = inflateSync(payload, { maxOutputLength: MAX_FILE });
            else if (compression === 3)
                raw = payload;
            else if (compression === 4)
                raw = decodeAnvilLz4(payload, MAX_FILE);
            else
                fail('UNSUPPORTED_COMPRESSION', `Region compression ${compression} is unavailable; chunk is unknown`);
        }
        finally {
            await h.close();
        }
        this.stats.chunksRead++;
        const root = await decode(raw);
        if (!this.dataVersion)
            this.dataVersion = root.DataVersion;
        const c = root.Level ?? root;
        const sections = new Map();
        for (const section of c.sections ?? c.Sections ?? []) {
            const bs = section.block_states ?? (section.Palette ? { palette: section.Palette, data: section.BlockStates } : null);
            if (bs?.palette?.length)
                sections.set(Number(section.Y), { palette: bs.palette.map(state), data: bs.data ?? [], raw: section });
        }
        const status = String(c.Status ?? '').replace('minecraft:', '');
        return { sections, complete: status === 'full' || status === 'postprocessed', raw: c };
    }
    async getBlock(x, y, z) {
        if (y < this.bounds.min.y || y > this.bounds.max.y)
            return null;
        const chunk = await this.loadChunk(Math.floor(x / 16), Math.floor(z / 16));
        if (!chunk || !chunk.complete)
            return null;
        const section = chunk.sections.get(Math.floor(y / 16));
        if (!section)
            return AIR;
        if (section.palette.length === 1)
            return section.palette[0];
        const bits = Math.max(4, Math.ceil(Math.log2(section.palette.length)));
        const perLong = Math.floor(64 / bits);
        const index = ((x % 16 + 16) % 16) + ((z % 16 + 16) % 16) * 16 + ((y % 16 + 16) % 16) * 256;
        const packed = section.data[Math.floor(index / perLong)];
        if (!packed)
            return null;
        const paletteIndex = Number((long64(packed) >> BigInt((index % perLong) * bits)) & ((1n << BigInt(bits)) - 1n));
        return section.palette[paletteIndex] ?? null;
    }
    async getEnvironment(x, y, z) {
        const chunk = await this.loadChunk(Math.floor(x / 16), Math.floor(z / 16));
        if (!chunk?.complete)
            return { known: false, reason: 'chunk-missing-or-incomplete' };
        const section = chunk.sections.get(Math.floor(y / 16))?.raw;
        if (!section)
            return { known: false, reason: 'saved-section-environment-absent' };
        const lx = (x % 16 + 16) % 16, ly = (y % 16 + 16) % 16, lz = (z % 16 + 16) % 16, index = lx + lz * 16 + ly * 256, light = {};
        for (const [key, name] of [['SkyLight', 'sky'], ['BlockLight', 'block']])
            if (section[key]?.length === 2048)
                light[name] = (section[key][index >>> 1] >>> ((index & 1) * 4)) & 15;
        const biomes = section.biomes, palette = biomes?.palette;
        let biome;
        if (palette?.length) {
            let selected = palette[0];
            if (palette.length > 1) {
                const bits = Math.max(1, Math.ceil(Math.log2(palette.length))), per = Math.floor(64 / bits), i = Math.floor(lx / 4) + Math.floor(lz / 4) * 4 + Math.floor(ly / 4) * 16, packed = biomes.data?.[Math.floor(i / per)];
                selected = packed ? palette[Number((long64(packed) >> BigInt((i % per) * bits)) & ((1n << BigInt(bits)) - 1n))] : undefined;
            }
            while (selected && typeof selected === 'object' && Object.keys(selected).length === 1 && Object.hasOwn(selected, ''))
                selected = selected[''];
            if (typeof selected === 'string')
                biome = selected;
        }
        return { known: Boolean(biome && light.sky !== undefined && light.block !== undefined), ...(biome ? { biome } : {}), ...(Object.keys(light).length ? { light } : {}), ...(!biome || light.sky === undefined || light.block === undefined ? { reason: 'some-saved-environment-values-absent' } : {}) };
    }
    async getBlockEntities(b, signal) { const out = []; for (let cz = Math.floor(b.min.z / 16); cz <= Math.floor(b.max.z / 16); cz++)
        for (let cx = Math.floor(b.min.x / 16); cx <= Math.floor(b.max.x / 16); cx++) {
            if (signal?.aborted)
                fail('CANCELLED', 'Block entity read cancelled');
            const chunk = await this.loadChunk(cx, cz);
            for (const value of chunk?.raw.block_entities ?? chunk?.raw.TileEntities ?? []) {
                const position = { x: value.x, y: value.y, z: value.z };
                if (contains(b, position))
                    out.push({ id: value.id ?? 'minecraft:unknown_block_entity', position, nbt: value });
            }
        } return out; }
    async getEntities(b, signal) {
        if (basename(this.regionDir).toLowerCase() !== 'region')
            return [];
        const count = (Math.floor(b.max.x / 16) - Math.floor(b.min.x / 16) + 1) * (Math.floor(b.max.z / 16) - Math.floor(b.min.z / 16) + 1);
        if (count > 4096)
            fail('BOUNDS_TOO_LARGE', 'Entity reads are limited to 4096 horizontal chunks');
        const out = [];
        for (let cz = Math.floor(b.min.z / 16); cz <= Math.floor(b.max.z / 16); cz++)
            for (let cx = Math.floor(b.min.x / 16); cx <= Math.floor(b.max.x / 16); cx++) {
                if (signal?.aborted)
                    fail('CANCELLED', 'Entity read cancelled');
                const file = join(dirname(this.regionDir), 'entities', `r.${Math.floor(cx / 32)}.${Math.floor(cz / 32)}.mca`);
                let raw;
                try {
                    raw = await regionPayload(file, cx, cz);
                }
                catch (error) {
                    if (error.code === 'ENOENT')
                        continue;
                    throw error;
                }
                if (!raw)
                    continue;
                const parsed = (await nbt.parse(raw, 'big')).parsed, items = parsed.value.Entities ?? parsed.value.entities;
                if (!items)
                    continue;
                const wrapped = tag('compound', { Entities: items });
                for (const entity of parseMapEntities(wrapped, 'schematic', { x: 0, y: 0, z: 0 }))
                    if (entityInBounds(entity, b))
                        out.push(entityView(entity));
                if (out.length > 4096)
                    fail('TOO_MANY_ENTITIES', 'Entity read exceeds4096 roots');
            }
        return out;
    }
    metadata() { return { format: 'anvil', regions: this.regions.size, regionDirectory: this.regionDir, ...this.stats, unavailableChunks: Object.fromEntries(this.failures) }; }
    async changed() {
        const current = (await readdir(this.regionDir)).filter(f => /^r\.-?\d+\.-?\d+\.mca$/.test(f));
        if (extname(this.path) !== '.mca' && current.length !== this.regions.size)
            return true;
        for (const r of this.regions.values()) {
            try {
                if (signature(await stat(r.path)) !== r.signature)
                    return true;
            }
            catch {
                return true;
            }
        }
        return false;
    }
    async close() { this.chunks.clear(); }
}
export async function openMap(path, options = {}) {
    path = resolve(path);
    let s;
    try {
        s = await stat(path);
    }
    catch {
        fail('MAP_NOT_FOUND', `Map source does not exist: ${path}`);
    }
    if (options.dimension && (!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(options.dimension) || options.dimension.includes('..')))
        fail('INVALID_DIMENSION', 'Use a namespaced dimension, e.g. minecraft:overworld');
    try {
        if (s.isDirectory() || extname(path).toLowerCase() === '.mca')
            return await AnvilReader.load(path, options.version, options.dimension);
        if (extname(path).toLowerCase() === '.schem' || extname(path).toLowerCase() === '.nbt') {
            const reader = extname(path).toLowerCase() === '.schem' ? await SchematicReader.load(path, options.version) : await StructureReader.load(path, options.version);
            // Portable structures have no inherent dimension; honor the caller's
            // inspection context instead of silently forcing the overworld.
            if (options.dimension)
                reader.dimension = options.dimension;
            return reader;
        }
        fail('UNSUPPORTED_MAP_FORMAT', 'Use a world folder, .mca, Sponge .schem, or Java structure .nbt');
    }
    catch (e) {
        if (e instanceof ToolError)
            throw e;
        fail('MAP_READ_FAILED', `Cannot read ${path}`, { reason: String(e) });
    }
}
//# sourceMappingURL=readers.js.map