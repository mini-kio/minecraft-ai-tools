import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { deflateSync, gzipSync } from 'node:zlib';
import { MapService } from '../src/maps/index.js';
const require = createRequire(import.meta.url); const nbt = require('prismarine-nbt');
const tag = (type: string, value: any): any => ({ type, value });
const list = (type: string, value: any[]): any => tag('list', { type, value });
const encode = (value: any): Buffer => nbt.writeUncompressed({ name: '', type: 'compound', value });
const stone = { Name: tag('string', 'minecraft:stone') }; const air = { Name: tag('string', 'minecraft:air') };
const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
async function fixture(): Promise<{ dir: string; svc: MapService }> { const dir = await mkdtemp(join(tmpdir(), 'mct-map-test-')); return { dir, svc: new MapService({ artifactDir: join(dir, 'artifacts'), stateDir: join(dir, 'state') }) }; }

test('Java structure reads blocks, produces PNG slices/3D capture, and never edits source', async () => {
  const { dir, svc } = await fixture(); const path = join(dir, 'room.nbt');
  const source = gzipSync(encode({ DataVersion: tag('int', 3465), size: list('int', [4, 4, 4]), palette: list('compound', [stone, air]), blocks: list('compound', [{ pos: list('int', [1, 0, 1]), state: tag('int', 0) }, { pos: list('int', [2, 0, 1]), state: tag('int', 1) }]) }));
  await writeFile(path, source); const opened = await svc.call('open', { path }); assert.equal(opened.version, '1.20.1');
  const block = await svc.call('inspect', { session: opened.session, position: { x: 1, y: 0, z: 1 } }); assert.equal(block.block.name, 'minecraft:stone'); assert.equal(block.block.shapes.length, 1);
  const empty = await svc.call('inspect', { session: opened.session, position: { x: 2, y: 0, z: 1 } }); assert.equal(empty.block.name, 'minecraft:air');
  const omitted = await svc.call('inspect', { session: opened.session, position: { x: 3, y: 0, z: 1 } }); assert.equal(omitted.block.known, false);
  const slice = await svc.call('slice', { session: opened.session, axis: 'y', at: 1 }); assert.equal((await readFile(slice.imagePath)).subarray(1, 4).toString(), 'PNG');
  await assert.rejects(() => svc.call('slice', { session: opened.session, axis: 'y', at: 1e300 }), (e: any) => e.code === 'INVALID_ARGUMENT');
  await assert.rejects(() => svc.call('inspect', { session: opened.session, bounds: { min: { x: 1e300, y: 0, z: 0 }, max: { x: 1e300, y: 1, z: 1 } } }), (e: any) => e.code === 'INVALID_ARGUMENT');
  const capture = await svc.call('capture', { session: opened.session }); assert.equal((await readFile(capture.imagePath)).subarray(1, 4).toString(), 'PNG');
  assert.equal(hash(await readFile(path)), hash(source)); assert.equal((await svc.call('observe', { session: opened.session })).changed, false);
  await svc.close();
});

for (const version of [1, 2, 3]) test(`Sponge v${version} decodes palette varints and origin`, async () => {
  const { dir, svc } = await fixture(); const path = join(dir, 'fixture.schem');
  const common = { Version: tag('int', version), DataVersion: tag('int', 3465), Width: tag('short', 2), Height: tag('short', 1), Length: tag('short', 1), Offset: tag('intArray', [-5, 4, 10]) };
  const palette = tag('compound', { 'minecraft:stone': tag('int', 0), 'minecraft:oak_slab[type=bottom,waterlogged=false]': tag('int', 128) });
  const value = version === 3 ? { Schematic: tag('compound', { ...common, Blocks: tag('compound', { Palette: palette, Data: tag('byteArray', [0, -128, 1]) }) }) } : { ...common, Palette: palette, BlockData: tag('byteArray', [0, -128, 1]) };
  const source = gzipSync(encode(value)); await writeFile(path, source); const opened = await svc.call('open', { path, dimension: 'minecraft:the_nether' }); assert.equal(opened.dimension, 'minecraft:the_nether');
  const block = await svc.call('inspect', { session: opened.session, position: { x: -4, y: 4, z: 10 } }); assert.equal(block.block.name, 'minecraft:oak_slab'); assert.equal(block.block.properties.type, 'bottom'); assert.equal(block.block.shapes[0][4], 0.5);
  assert.equal(hash(await readFile(path)), hash(source)); await svc.close();
});

test('Anvil indexes region header, decodes exact packed palette indices, and marks missing chunks unknown', async () => {
  const { dir, svc } = await fixture(); await mkdir(join(dir, 'region'));
  const packed = Array.from({ length: 256 }, (_, i) => i < 16 ? [0, 0] : [0x11111111, 0x11111111]);
  const chunk = (x: number, z: number): Buffer => deflateSync(encode({ DataVersion: tag('int', 3465), xPos: tag('int', x), zPos: tag('int', z), Status: tag('string', 'minecraft:full'), sections: list('compound', [{ Y: tag('byte', 0), block_states: tag('compound', { palette: list('compound', [stone, air]), data: tag('longArray', packed) }) }]) }));
  const compressed = chunk(1, 0), other = chunk(0, 1); const sectors = Math.ceil((compressed.length + 5) / 4096), otherSectors = Math.ceil((other.length + 5) / 4096); const region = Buffer.alloc(8192 + (sectors + otherSectors) * 4096);
  for (const [index, sector, count, data] of [[1, 2, sectors, compressed], [32, 2 + sectors, otherSectors, other]] as Array<[number, number, number, Buffer]>) { region.writeUInt32BE((sector << 8) | count, index * 4); region.writeUInt32BE(data.length + 1, sector * 4096); region[sector * 4096 + 4] = 2; data.copy(region, sector * 4096 + 5); }
  const regionPath = join(dir, 'region', 'r.0.0.mca'); await writeFile(regionPath, region);
  const opened = await svc.call('open', { path: dir }); assert.equal(opened.version, '1.20.1'); assert.equal(opened.source.chunksRead, 1);
  const ground = await svc.call('inspect', { session: opened.session, position: { x: 31, y: 0, z: 15 } }); assert.equal(ground.block.name, 'minecraft:stone');
  const empty = await svc.call('inspect', { session: opened.session, position: { x: 31, y: 1, z: 15 } }); assert.equal(empty.block.name, 'minecraft:air');
  const missing = await svc.call('inspect', { session: opened.session, position: { x: 0, y: 0, z: 0 } }); assert.equal(missing.block.known, false);
  await assert.rejects(() => svc.call('open', { path: regionPath, version: '1.21.1' }), (e: any) => e.code === 'VERSION_MISMATCH');
  const modernOverworld = join(dir, 'dimensions', 'minecraft', 'overworld', 'region'); await mkdir(modernOverworld, { recursive: true }); await writeFile(join(modernOverworld, 'r.0.0.mca'), region);
  const modern = await svc.call('open', { path: dir }); assert.equal(modern.source.regionDirectory, modernOverworld, 'modern storage must take precedence over the existing legacy region folder');
  const modernNether = join(dir, 'dimensions', 'minecraft', 'the_nether', 'region'); await mkdir(modernNether, { recursive: true }); await writeFile(join(modernNether, 'r.0.0.mca'), region);
  const nether = await svc.call('open', { path: dir, dimension: 'minecraft:the_nether' }); assert.equal(nether.source.regionDirectory, modernNether);
  const direct = await svc.call('open', { path: modernNether, dimension: 'minecraft:the_nether' }); assert.equal(direct.source.regionDirectory, modernNether);
  const legacyEnd = join(dir, 'DIM1', 'region'); await mkdir(legacyEnd, { recursive: true }); await writeFile(join(legacyEnd, 'r.0.0.mca'), region);
  assert.equal((await svc.call('open', { path: dir, dimension: 'minecraft:the_end' })).source.regionDirectory, legacyEnd);
  const paperWorld = join(dir, 'paper', 'world'), paperNether = join(dir, 'paper', 'world_nether', 'DIM-1', 'region'); await mkdir(paperWorld, { recursive: true }); await mkdir(paperNether, { recursive: true }); await writeFile(join(paperNether, 'r.0.0.mca'), region);
  assert.equal((await svc.call('open', { path: paperWorld, dimension: 'minecraft:the_nether' })).source.regionDirectory, paperNether);
  assert.equal(hash(await readFile(regionPath)), hash(region)); await svc.close();
});

test('invalid schematic palette data fails without creating a session', async () => {
  const { dir, svc } = await fixture(); const path = join(dir, 'invalid.schem'); await writeFile(path, encode({ Version: tag('int', 2), Width: tag('short', 2), Height: tag('short', 1), Length: tag('short', 1), Palette: tag('compound', { 'minecraft:air': tag('int', 0) }), BlockData: tag('byteArray', [0]) }));
  await assert.rejects(() => svc.call('open', { path }), (e: any) => e.code === 'INVALID_SCHEMATIC'); assert.deepEqual(await svc.call('list', {}), []);
});

test('26.x modern mixed block palettes decode wrapped strings and lower-case state properties', async () => {
  const { dir, svc } = await fixture(); const regionDir = join(dir, 'dimensions', 'minecraft', 'overworld', 'region'); await mkdir(regionDir, { recursive: true });
  const packed = Array.from({ length: 256 }, (_, i) => i < 16 ? [0, 0] : [0x11111111, 0x11111111]); packed[0] = [0, 2];
  const palette = [{ '': tag('string', 'minecraft:stone') }, { '': tag('string', 'minecraft:air') }, { id: tag('string', 'minecraft:chest'), properties: tag('compound', { facing: tag('string', 'west'), type: tag('string', 'single'), waterlogged: tag('string', 'false') }) }];
  const compressed = deflateSync(encode({ DataVersion: tag('int', 5023), Status: tag('string', 'minecraft:full'), sections: list('compound', [{ Y: tag('byte', 0), block_states: tag('compound', { palette: list('compound', palette), data: tag('longArray', packed) }) }]) }));
  const sectors = Math.ceil((compressed.length + 5) / 4096), region = Buffer.alloc(8192 + sectors * 4096); region.writeUInt32BE((2 << 8) | sectors, 0); region.writeUInt32BE(compressed.length + 1, 8192); region[8196] = 2; compressed.copy(region, 8197); await writeFile(join(regionDir, 'r.0.0.mca'), region);
  const opened = await svc.call('open', { path: dir, version: '26.3' }); assert.equal(opened.source.regionDirectory, regionDir);
  const chest = (await svc.call('inspect', { session: opened.session, position: { x: 0, y: 0, z: 0 } })).block; assert.equal(chest.name, 'minecraft:chest'); assert.equal(chest.properties.facing, 'west'); assert.equal(chest.known, true);
  assert.equal((await svc.call('inspect', { session: opened.session, position: { x: 1, y: 0, z: 0 } })).block.name, 'minecraft:stone');
  assert.equal((await svc.call('inspect', { session: opened.session, position: { x: 1, y: 1, z: 0 } })).block.name, 'minecraft:air'); await svc.close();
});

test('an explicit version conflicting with DataVersion is rejected', async () => {
  const { dir, svc } = await fixture(); const path = join(dir, 'fixture.nbt'); await writeFile(path, encode({ DataVersion: tag('int', 3465), size: list('int', [1, 1, 1]), palette: list('compound', [air]), blocks: list('compound', [{ pos: list('int', [0, 0, 0]), state: tag('int', 0) }]) }));
  await assert.rejects(() => svc.call('open', { path, version: '1.21.1' }), (e: any) => e.code === 'VERSION_MISMATCH');
});
