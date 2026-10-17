import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile, lstat, open, realpath, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, extname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { setTimeout as delay, setImmediate as yieldNow } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { fail, ToolError } from '../contracts.js';
import { parseMapEntities, prepareEntities, summonSkeleton, importedEntityUuid, tag, nbtList } from './entities.js';
import { openMap, readTypedMapNbt } from './readers.js';
import { bounds as parseBounds, stateString } from './types.js';
const nbtLibrary = createRequire(import.meta.url)('prismarine-nbt');
function check(signal) { if (signal?.aborted)
    fail('CANCELLED', 'Map staging was cancelled'); }
async function pause(ms, signal) { try {
    await delay(ms, undefined, { signal });
}
catch (error) {
    check(signal);
    throw error;
} }
async function digest(path, signal) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) {
    check(signal);
    hash.update(chunk);
} return hash.digest('hex'); }
export async function verifyStageSources(plan, signal) {
    for (const source of plan.sourceHashes) {
        check(signal);
        if (await digest(source.path, signal) !== source.sha256)
            fail('SOURCE_CHANGED', 'The original map changed during staging; import was not verified', { path: source.path });
    }
}
const resource = /^[a-z0-9_.-]+:[a-z0-9_/.-]+$/;
function commandState(name, properties) {
    if (!resource.test(name) || Object.entries(properties).some(([k, v]) => !/^[a-z0-9_]+$/.test(k) || !/^[a-z0-9_.:-]+$/.test(v)))
        fail('INVALID_BLOCK_STATE', 'Map contains a block state that cannot be safely imported through Vanilla commands', { name });
    return stateString({ name, properties });
}
function nbtString(value) {
    if (/[\u0000-\u001f]/.test(value))
        fail('BLOCK_ENTITY_UNREPRESENTABLE', 'A block entity contains a control character that cannot be preserved by a single-line Vanilla console command');
    return JSON.stringify(value);
}
/** Serialize the original typed NBT rather than guessing number widths from simplified JSON. */
export function typedNbtToSnbt(tag, mixedLists = false) {
    if (!tag || typeof tag.type !== 'string')
        fail('INVALID_NBT', 'Invalid typed block entity tag');
    const v = tag.value;
    const number = (suffix) => { if (typeof v !== 'number' || !Number.isFinite(v))
        fail('BLOCK_ENTITY_UNREPRESENTABLE', 'Non-finite NBT numbers cannot be imported without loss'); return (Object.is(v, -0) ? '-0.0' : String(v)) + suffix; };
    const long = (value) => { const n = typeof value === 'bigint' ? value : Array.isArray(value) ? (BigInt(value[0] >>> 0) << 32n) | BigInt(value[1] >>> 0) : BigInt(value); return BigInt.asIntN(64, n).toString() + 'L'; };
    switch (tag.type) {
        case 'compound': return '{' + Object.entries(v).map(([k, t]) => `${nbtString(k)}:${typedNbtToSnbt(t, mixedLists)}`).join(',') + '}';
        case 'list': return '[' + v.value.map((value) => typedNbtToSnbt(mixedLists && v.type === 'compound' && Object.keys(value).length === 1 && Object.hasOwn(value, '') ? value[''] : { type: v.type, value }, mixedLists)).join(',') + ']';
        case 'string': return nbtString(String(v));
        case 'byte': return number('b');
        case 'short': return number('s');
        case 'int': return number('');
        case 'float': return number('f');
        case 'double': return number('d');
        case 'long': return long(v);
        case 'byteArray': return '[B;' + [...v].map(n => `${n > 127 ? n - 256 : n}b`).join(',') + ']';
        case 'intArray': return '[I;' + [...v].join(',') + ']';
        case 'longArray': return '[L;' + [...v].map(long).join(',') + ']';
        default: fail('BLOCK_ENTITY_UNREPRESENTABLE', `Unsupported block entity NBT tag ${tag.type}`);
    }
}
function simple(tag) {
    if (!tag)
        return undefined;
    if (tag.type === 'compound')
        return Object.fromEntries(Object.entries(tag.value).map(([k, v]) => [k, simple(v)]));
    if (tag.type === 'list')
        return tag.value.value.map((v) => simple({ type: tag.value.type, value: v }));
    return tag.value;
}
function listItems(tag) { return tag?.type === 'list' ? tag.value.value.map((v) => ({ type: tag.value.type, value: v })) : []; }
function inside(b, p) { return ['x', 'y', 'z'].every(k => p[k] >= b.min[k] && p[k] <= b.max[k]); }
async function blockEntities(root, kind, offset) {
    const result = new Map();
    const put = (p, data) => {
        if (!['x', 'y', 'z'].every(k => Number.isInteger(p[k])) || data?.type !== 'compound')
            fail('INVALID_BLOCK_ENTITY', 'Block entity coordinates or data are invalid');
        const value = { ...data.value };
        delete value.x;
        delete value.y;
        delete value.z;
        delete value.Pos;
        delete value.Id;
        delete value.ContentVersion;
        result.set(`${p.x},${p.y},${p.z}`, { type: 'compound', value });
    };
    if (kind === 'structure') {
        for (const item of listItems(root.value.blocks)) {
            const pos = simple(item.value.pos);
            if (item.value.nbt)
                put({ x: pos[0] + offset.x, y: pos[1] + offset.y, z: pos[2] + offset.z }, item.value.nbt);
        }
    }
    else {
        const s = root.value.Schematic ?? root;
        const list = s.value.Blocks?.value.BlockEntities ?? s.value.BlockEntities ?? s.value.TileEntities;
        for (const item of listItems(list)) {
            const pos = simple(item.value.Pos ?? item.value.pos);
            if (!Array.isArray(pos) || pos.length !== 3)
                fail('INVALID_BLOCK_ENTITY', 'Sponge block entity needs local Pos coordinates');
            put({ x: pos[0] + offset.x, y: pos[1] + offset.y, z: pos[2] + offset.z }, item.value.Data ?? item);
        }
    }
    return result;
}
function logLines(value) {
    const values = Array.isArray(value) ? value : value?.lines ?? [];
    return values.map((line) => typeof line === 'string' ? line : String(line.line ?? line.message ?? ''));
}
export async function prepareMapStage(sourcePath, options) {
    check(options.signal);
    const source = resolve(sourcePath);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink())
        fail('FILE_SOURCE_REQUIRED', 'Portable staging requires a regular .schem, .nbt or .mca source file');
    if (!options.version || !options.workDir)
        fail('INVALID_ARGUMENT', 'Staging requires an exact version and workDir');
    if (!['.schem', '.nbt', '.mca'].includes(extname(source).toLowerCase()))
        fail('UNSUPPORTED_MAP_FORMAT', 'Portable staging supports .schem, .nbt and .mca files');
    if (extname(source).toLowerCase() !== '.mca' && info.size > 128 * 1024 * 1024)
        fail('FILE_TOO_LARGE', 'NBT file exceeds 128 MiB');
    // Hash before the first parser read; otherwise a source replaced between
    // parsing and hashing could combine old blocks with a new entity payload.
    const originalHash = await digest(source, options.signal);
    const reader = await openMap(source, { version: options.version, dimension: options.dimension });
    const workRoot = resolve(options.workDir);
    let ownedStageDir;
    try {
        const dimension = reader.dimension;
        if (!['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'].includes(dimension))
            fail('CUSTOM_DIMENSION_REQUIRED', 'A portable file cannot create a custom dimension; stage a complete world containing its dimension data pack');
        const selected = extname(source).toLowerCase() === '.mca' ? (options.bounds ? parseBounds(options.bounds, undefined, 16_777_216) : reader.bounds) : parseBounds(options.bounds, reader.bounds, options.maxVolume ?? 262_144);
        for (const axis of ['x', 'y', 'z'])
            if (selected.min[axis] < reader.bounds.min[axis] || selected.max[axis] > reader.bounds.max[axis])
                fail('BOUNDS_OUTSIDE_SOURCE', 'Import bounds must stay inside the source');
        const stageDir = join(workRoot, 'stage-' + randomUUID());
        await mkdir(stageDir, { recursive: true });
        ownedStageDir = stageDir;
        const hashes = [{ path: source, sha256: originalHash }];
        const center = { x: (selected.min.x + selected.max.x + 1) / 2, y: selected.max.y + 2, z: (selected.min.z + selected.max.z + 1) / 2 };
        const plan = { kind: reader.kind === 'anvil' ? 'region-copy' : 'block-import', source, version: options.version, dimension, bounds: selected, origin: { ...reader.bounds.min }, focus: center, serverProperties: { 'level-type': 'minecraft:flat', 'generator-settings': JSON.stringify({ biome: 'minecraft:the_void', layers: [], structure_overrides: [] }), 'generate-structures': 'false' }, commands: [], blockCount: 0, blockEntities: 0, sourceHashes: hashes, planPath: join(stageDir, 'plan.json'), warnings: [] };
        if (plan.kind === 'region-copy') {
            const modern = /^26\./.test(options.version);
            const folder = modern ? join('dimensions', ...dimension.split(':'), 'region') : dimension === 'minecraft:overworld' ? 'region' : join(dimension === 'minecraft:the_nether' ? 'DIM-1' : 'DIM1', 'region');
            const target = join(stageDir, 'world', folder);
            await mkdir(target, { recursive: true });
            const copy = async (from, to) => { check(options.signal); if ((await lstat(from)).isSymbolicLink())
                fail('UNSAFE_SOURCE', 'Region sidecars cannot be symlinks'); await pipeline(createReadStream(from), createWriteStream(to, { flags: 'wx' }), { signal: options.signal }); };
            await copy(source, join(target, basename(source)));
            const match = /^r\.(-?\d+)\.(-?\d+)\.mca$/i.exec(basename(source));
            const handle = await open(source, 'r');
            try {
                const header = Buffer.alloc(4096);
                await handle.read(header, 0, 4096, 0);
                for (let i = 0; i < 1024; i++) {
                    check(options.signal);
                    const offset = header.readUInt32BE(i * 4) >>> 8;
                    if (!offset)
                        continue;
                    const flag = Buffer.alloc(1);
                    await handle.read(flag, 0, 1, offset * 4096 + 4);
                    if (flag[0] & 128) {
                        const cx = Number(match[1]) * 32 + i % 32, cz = Number(match[2]) * 32 + Math.floor(i / 32), name = `c.${cx}.${cz}.mcc`, sidecar = join(dirname(source), name);
                        hashes.push({ path: sidecar, sha256: await digest(sidecar, options.signal) });
                        await copy(sidecar, join(target, name));
                    }
                }
            }
            finally {
                await handle.close();
            }
            if (basename(dirname(source)).toLowerCase() === 'region') {
                const entityFile = join(dirname(dirname(source)), 'entities', basename(source));
                let exists = false;
                try {
                    exists = (await lstat(entityFile)).isFile();
                }
                catch (error) {
                    if (error.code !== 'ENOENT')
                        throw error;
                }
                if (exists) {
                    const entityTarget = join(dirname(target), 'entities');
                    await mkdir(entityTarget, { recursive: true });
                    hashes.push({ path: entityFile, sha256: await digest(entityFile, options.signal) });
                    await copy(entityFile, join(entityTarget, basename(source)));
                    const entityHandle = await open(entityFile, 'r');
                    try {
                        const header = Buffer.alloc(4096);
                        await entityHandle.read(header, 0, 4096, 0);
                        for (let i = 0; i < 1024; i++) {
                            check(options.signal);
                            const offset = header.readUInt32BE(i * 4) >>> 8;
                            if (!offset)
                                continue;
                            const flag = Buffer.alloc(1);
                            await entityHandle.read(flag, 0, 1, offset * 4096 + 4);
                            if (flag[0] & 128) {
                                const cx = Number(match[1]) * 32 + i % 32, cz = Number(match[2]) * 32 + Math.floor(i / 32), name = `c.${cx}.${cz}.mcc`, sidecar = join(dirname(entityFile), name);
                                hashes.push({ path: sidecar, sha256: await digest(sidecar, options.signal) });
                                await copy(sidecar, join(entityTarget, name));
                            }
                        }
                    }
                    finally {
                        await entityHandle.close();
                    }
                    plan.warnings.push('The matching saved-entity region and external chunks are copied with the selected block region, including entities outside camera bounds.');
                }
            }
            plan.copiedWorldPath = join(stageDir, 'world');
            plan.warnings.push('Region chunks are preserved byte-for-byte. Vanilla generates fresh level metadata and surrounding chunks for this isolated world.');
        }
        else {
            const maxY = dimension === 'minecraft:overworld' ? 319 : 255, minY = dimension === 'minecraft:overworld' ? -64 : 0;
            if (selected.min.y < minY || selected.max.y > maxY || selected.min.x < -30_000_000 || selected.max.x >= 30_000_000 || selected.min.z < -30_000_000 || selected.max.z >= 30_000_000)
                fail('OUTSIDE_VANILLA_BOUNDS', 'Portable source lies outside this Vanilla dimension build range; choose bounded in-range coordinates');
            const chunkCount = (Math.floor(selected.max.x / 16) - Math.floor(selected.min.x / 16) + 1) * (Math.floor(selected.max.z / 16) - Math.floor(selected.min.z / 16) + 1);
            if (chunkCount > 256)
                fail('STAGE_TOO_WIDE', 'Import spans more than 256 chunks; stage a smaller bounds');
            const typedSource = await readTypedMapNbt(source), entities = await blockEntities(typedSource, reader.kind, reader.bounds.min), cell = new Map(), storageBlocks = [], storageEntities = [];
            let scanned = 0;
            const parts = options.version.split('.').map(Number), mixedLists = parts[0] >= 26 || parts[0] === 1 && (parts[1] > 21 || parts[1] === 21 && (parts[2] ?? 0) >= 5);
            for (let y = selected.min.y; y <= selected.max.y; y++)
                for (let z = selected.min.z; z <= selected.max.z; z++)
                    for (let x = selected.min.x; x <= selected.max.x; x++) {
                        if (++scanned % 1024 === 0)
                            await yieldNow();
                        check(options.signal);
                        const value = await reader.getBlock(x, y, z);
                        if (!value)
                            continue;
                        if (value.name === 'minecraft:structure_void')
                            continue;
                        cell.set(`${x},${y},${z}`, commandState(value.name, value.properties));
                        plan.blockCount++;
                    }
            if (!cell.size)
                fail('EMPTY_IMPORT', 'Selected source has no explicit blocks to import');
            const prefix = `execute in ${dimension} run `;
            plan.commands.push(prefix + `forceload add ${selected.min.x} ${selected.min.z} ${selected.max.x} ${selected.max.z}`);
            const visited = new Set(), maximum = options.maxCommands ?? 20000, restoreStates = [];
            // Greedy rectangular fills preserve every explicit air cell and state;
            // unknown Java structure entries remain untouched in the fresh world.
            for (let y = selected.min.y; y <= selected.max.y; y++)
                for (let z = selected.min.z; z <= selected.max.z; z++)
                    for (let x = selected.min.x; x <= selected.max.x; x++) {
                        if (++scanned % 1024 === 0)
                            await yieldNow();
                        check(options.signal);
                        const k = `${x},${y},${z}`, value = cell.get(k);
                        if (!value || visited.has(k))
                            continue;
                        let x1 = x;
                        while (x1 < selected.max.x && x1 - x < 255 && cell.get(`${x1 + 1},${y},${z}`) === value && !visited.has(`${x1 + 1},${y},${z}`))
                            x1++;
                        let z1 = z;
                        outer: while (z1 < selected.max.z && (x1 - x + 1) * (z1 - z + 2) <= 32768) {
                            for (let xx = x; xx <= x1; xx++)
                                if (cell.get(`${xx},${y},${z1 + 1}`) !== value || visited.has(`${xx},${y},${z1 + 1}`))
                                    break outer;
                            z1++;
                        }
                        let y1 = y;
                        vertical: while (y1 < selected.max.y && (x1 - x + 1) * (z1 - z + 1) * (y1 - y + 2) <= 32768) {
                            for (let zz = z; zz <= z1; zz++)
                                for (let xx = x; xx <= x1; xx++)
                                    if (cell.get(`${xx},${y1 + 1},${zz}`) !== value || visited.has(`${xx},${y1 + 1},${zz}`))
                                        break vertical;
                            y1++;
                        }
                        for (let yy = y; yy <= y1; yy++)
                            for (let zz = z; zz <= z1; zz++)
                                for (let xx = x; xx <= x1; xx++)
                                    visited.add(`${xx},${yy},${zz}`);
                        const command = prefix + (x === x1 && y === y1 && z === z1 ? `setblock ${x} ${y} ${z} ${value}` : `fill ${x} ${y} ${z} ${x1} ${y1} ${z1} ${value}`);
                        plan.commands.push(command);
                        if (value.includes('['))
                            restoreStates.push(command);
                        if (plan.commands.length > maximum)
                            fail('STAGE_TOO_COMPLEX', `Import exceeds ${maximum} compressed commands; choose smaller bounds`);
                    }
            plan.commands.push(...restoreStates);
            for (const [key, data] of entities) {
                check(options.signal);
                const [x, y, z] = key.split(',').map(Number), position = { x, y, z };
                if (!inside(selected, position))
                    continue;
                if (!cell.has(key))
                    continue;
                let snbt;
                try {
                    snbt = typedNbtToSnbt(data, mixedLists);
                }
                catch (error) {
                    if (!(error instanceof ToolError) || error.code !== 'BLOCK_ENTITY_UNREPRESENTABLE')
                        throw error;
                }
                const command = snbt && prefix + `data merge block ${x} ${y} ${z} ${snbt}`;
                if (command && command.length <= 30000)
                    plan.commands.push(command);
                else {
                    const index = storageBlocks.length;
                    storageBlocks.push(data.value);
                    for (const field of Object.keys(data.value))
                        plan.commands.push(prefix + `data modify block ${x} ${y} ${z} ${nbtString(field)} set from storage mct:stage blockEntities[${index}].${nbtString(field)}`);
                }
                plan.blockEntities++;
            }
            const imported = prepareEntities(parseMapEntities(typedSource, reader.kind, reader.bounds.min), selected, basename(stageDir).slice(6));
            plan.entityCount = imported.flat.length;
            plan.entityTreeCount = imported.roots.length;
            plan.entityTag = imported.tag;
            plan.entityUuids = imported.flat.map(importedEntityUuid);
            plan.excludedEntities = imported.excluded;
            plan.uuidRemap = imported.uuidMap;
            if (imported.flat.length) {
                const modern = parts[0] >= 26 || parts[0] === 1 && parts[1] === 21 && (parts[2] ?? 0) >= 11, mobDrops = modern ? 'minecraft:mob_drops' : 'doMobLoot', entityDrops = modern ? 'minecraft:entity_drops' : 'doEntityDrops';
                plan.commands.push(`execute store result storage mct:stage mobDrops byte 1 run gamerule ${mobDrops}`, `execute store result storage mct:stage entityDrops byte 1 run gamerule ${entityDrops}`, `gamerule ${mobDrops} false`, `gamerule ${entityDrops} false`, prefix + `kill @e[tag=${imported.tag}]`, `execute if data storage mct:stage {mobDrops:1b} run gamerule ${mobDrops} true`, `execute if data storage mct:stage {mobDrops:0b} run gamerule ${mobDrops} false`, `execute if data storage mct:stage {entityDrops:1b} run gamerule ${entityDrops} true`, `execute if data storage mct:stage {entityDrops:0b} run gamerule ${entityDrops} false`, `data modify storage mct:stage failedEntities set value []`);
                for (const entity of imported.roots) {
                    const p = entity.position, command = prefix + `summon ${entity.id} ${p.x} ${p.y} ${p.z} ${typedNbtToSnbt(summonSkeleton(entity), mixedLists)}`;
                    if (command.length > 30000)
                        fail('ENTITY_TOO_LARGE', 'Entity passenger identity tree exceeds command budget');
                    plan.commands.push(command);
                }
                for (const entity of imported.flat) {
                    check(options.signal);
                    const index = storageEntities.length, selector = `@e[tag=${entity.importTags[1]},limit=1]`;
                    storageEntities.push(entity.nbt.value);
                    for (const field of Object.keys(entity.nbt.value)) {
                        if (['id', 'UUID', 'Passengers'].includes(field))
                            continue;
                        plan.commands.push(prefix + `data modify entity ${selector} ${nbtString(field)} set from storage mct:stage entities[${index}].${nbtString(field)}`);
                    }
                    plan.commands.push(prefix + `execute unless entity ${selector} run data modify storage mct:stage failedEntities append value "mct_entity_missing_${entity.importTags[1]}"`);
                }
                plan.commands.push('data get storage mct:stage failedEntities');
            }
            if (storageBlocks.length || storageEntities.length) {
                const payload = { type: 'compound', name: '', value: { DataVersion: tag('int', reader.dataVersion ?? 0), data: tag('compound', { contents: tag('compound', { stage: tag('compound', { entities: nbtList('compound', storageEntities), blockEntities: nbtList('compound', storageBlocks) }) }) }) } }, bytes = gzipSync(nbtLibrary.writeUncompressed(payload));
                plan.copiedWorldPath = join(stageDir, 'world');
                for (const file of [join(plan.copiedWorldPath, 'data', 'mct', 'command_storage.dat'), join(plan.copiedWorldPath, 'data', 'command_storage_mct.dat')]) {
                    check(options.signal);
                    await mkdir(dirname(file), { recursive: true });
                    await writeFile(file, bytes, { signal: options.signal });
                }
            }
            if (plan.commands.length > maximum)
                fail('STAGE_TOO_COMPLEX', `Import exceeds ${maximum} commands including block entities`);
            // Neighbor-dependent states (doors, fences, stairs) may have reacted while
            // the import was incomplete. A second state-only pass restores the source
            // properties after all neighbors exist, while retaining entity payloads.
            plan.warnings.push('Vanilla neighbor updates and block-entity ticking remain active; live client validation is required for dynamic blocks.');
            if (dimension !== 'minecraft:overworld')
                plan.warnings.push('The void preset applies to the overworld; this dimension retains Vanilla terrain in omitted structure cells and outside the explicitly imported blocks.');
            plan.commands.push(`setworldspawn ${Math.floor(center.x)} ${Math.min(maxY, Math.floor(center.y))} ${Math.floor(center.z)}`);
            if (plan.commands.length > maximum)
                fail('STAGE_TOO_COMPLEX', `Import exceeds ${maximum} commands including spawn metadata`);
        }
        await verifyStageSources(plan, options.signal);
        await writeFile(plan.planPath, JSON.stringify(plan, null, 2));
        return plan;
    }
    catch (error) {
        if (ownedStageDir) {
            // Only the fresh UUID directory created by this invocation is removable.
            // Resolve both paths before a recursive removal, including Windows junctions.
            const actual = await realpath(ownedStageDir), root = await realpath(workRoot), rel = relative(root, actual);
            if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || rel !== basename(ownedStageDir))
                fail('UNSAFE_STAGE_CLEANUP', 'Refused to remove a staging directory outside its owned work-root child');
            await rm(actual, { recursive: true, force: true });
        }
        throw error;
    }
    finally {
        await reader.close();
    }
}
export async function applyMapStage(plan, options) {
    check(options.signal);
    await verifyStageSources(plan, options.signal);
    const marker = 'mct_stage_' + randomUUID().replaceAll('-', ''), begin = marker + '_begin', done = marker + '_done', deadline = Date.now() + (options.timeoutMs ?? 180000);
    const send = async (command) => { check(options.signal); if (Date.now() > deadline)
        fail('STAGE_TIMEOUT', 'Map import exceeded its deadline'); await options.sendCommand(command); };
    const markerCommand = () => `data get storage mct:stage marker`;
    let previousMarker, observed = [];
    const waitMarker = async (value) => {
        await send(`data modify storage mct:stage marker set value "${value}"`);
        await send(markerCommand());
        while (Date.now() < deadline) {
            check(options.signal);
            observed = logLines(await options.readLogs());
            const end = observed.findIndex(line => line.includes(value));
            if (end >= 0) {
                const start = previousMarker ? observed.findIndex(line => line.includes(previousMarker)) : -1;
                const relevant = previousMarker ? observed.slice(start >= 0 ? start + 1 : 0, end + 1) : [];
                const failures = relevant.filter(line => /Unknown or incomplete command|Incorrect argument|Expected |Unknown block|Unknown entity|Unknown property|Invalid property|can not be set|cannot be set|An unexpected error occurred|Invalid block|Invalid value|not a valid|outside of the world|out of the world|not loaded|Too many blocks|Unclosed|Invalid resource|Cannot|Unable to|Not a block entity|Failed to parse|mct_entity_missing_/i.test(line) && !line.includes('No elements matching'));
                if (failures.length)
                    fail('STAGE_COMMAND_FAILED', 'Vanilla rejected one or more import commands', { failures: failures.slice(0, 20) });
                previousMarker = value;
                return;
            }
            await pause(100, options.signal);
        }
        fail('STAGE_TIMEOUT', 'Timed out waiting for Vanilla to process the import marker', { marker: value, lastLogs: observed.slice(-10) });
    };
    await waitMarker(begin);
    let sent = 0;
    for (const command of plan.commands) {
        await send(command);
        sent++;
        if (plan.entityTag && command.endsWith(`kill @e[tag=${plan.entityTag}]`)) {
            await waitMarker(marker + '_entity_cleanup');
            for (let i = 0; i < (plan.entityUuids?.length ?? 0); i += 64) {
                const value = marker + '_entities_removed_' + i, condition = plan.entityUuids.slice(i, i + 64).map(id => `unless entity ${id}`).join(' ');
                let removed = false;
                while (Date.now() < deadline) {
                    await send(`execute in ${plan.dimension} ${condition} run data modify storage mct:stage marker set value "${value}"`);
                    await send(markerCommand());
                    const logs = logLines(await options.readLogs());
                    if (logs.some(line => line.includes(value))) {
                        removed = true;
                        previousMarker = value;
                        break;
                    }
                    await pause(100, options.signal);
                }
                if (!removed)
                    fail('STAGE_TIMEOUT', 'Previous imported entity UUIDs were not released before retry');
            }
        }
        if (plan.kind === 'block-import' && sent === 1) {
            await waitMarker(marker + '_forced');
            const loaded = marker + '_loaded', conditions = [];
            for (let cz = Math.floor(plan.bounds.min.z / 16); cz <= Math.floor(plan.bounds.max.z / 16); cz++)
                for (let cx = Math.floor(plan.bounds.min.x / 16); cx <= Math.floor(plan.bounds.max.x / 16); cx++)
                    conditions.push(`if loaded ${cx * 16} ${plan.bounds.min.y} ${cz * 16}`);
            const probe = `execute in ${plan.dimension} ${conditions.join(' ')} run data modify storage mct:stage marker set value "${loaded}"`;
            let ready = false;
            while (Date.now() < deadline) {
                await send(probe);
                await send(markerCommand());
                const logs = logLines(await options.readLogs());
                if (logs.some(line => line.includes(loaded))) {
                    ready = true;
                    previousMarker = loaded;
                    break;
                }
                if (logs.slice(-8).some(line => /Unknown or incomplete command|Incorrect argument|Expected /i.test(line)))
                    fail('STAGE_COMMAND_FAILED', 'Vanilla rejected the loaded-chunk guard', { lastLogs: logs.slice(-8) });
                await pause(100, options.signal);
            }
            if (!ready)
                fail('STAGE_TIMEOUT', 'Imported chunks did not become loaded before placement');
        }
        if (sent % 64 === 0)
            await waitMarker(marker + '_batch_' + sent);
    }
    await waitMarker(done);
    if (plan.kind === 'block-import') {
        await send(`execute in ${plan.dimension} run forceload remove ${plan.bounds.min.x} ${plan.bounds.min.z} ${plan.bounds.max.x} ${plan.bounds.max.z}`);
        await waitMarker(done + '_released');
    }
    await verifyStageSources(plan, options.signal);
    return { kind: plan.kind, commandsProcessed: sent, blockCount: plan.blockCount, blockEntities: plan.blockEntities, entityCount: plan.entityCount ?? 0, entityTreeCount: plan.entityTreeCount ?? 0, entityTag: plan.entityTag, uuidRemap: plan.uuidRemap, originalFilesUnchanged: true, marker: done, bounds: plan.bounds, focus: plan.focus };
}
//# sourceMappingURL=staging.js.map