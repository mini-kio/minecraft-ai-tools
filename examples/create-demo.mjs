#!/usr/bin/env node
// A deterministic read-only observation fixture: two floors, working stairs,
// an open bedroom door, a sealed closet, and a deliberately low ceiling.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import nbt from 'prismarine-nbt';

const output = resolve(process.argv[2] || 'examples/generated');
const W = 16, H = 11, L = 12;
const cells = Array(W * H * L).fill('minecraft:air');
const put = (x, y, z, state) => { cells[x + z * W + y * W * L] = state; };
for (let x = 0; x < W; x++) for (let z = 0; z < L; z++) {
  put(x, 0, z, 'minecraft:stone_bricks');
  put(x, 9, z, 'minecraft:dark_oak_planks');
  if (x > 0 && x < W - 1 && z > 0 && z < L - 1 && !(z === 3 && x >= 2 && x <= 6)) put(x, 4, z, 'minecraft:oak_planks');
}
for (let y = 1; y < 9; y++) for (let x = 0; x < W; x++) for (let z = 0; z < L; z++) if (x === 0 || x === W - 1 || z === 0 || z === L - 1) put(x, y, z, 'minecraft:stone_bricks');
for (let step = 0; step < 4; step++) put(3 + step, 1 + step, 3, 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]');
for (let y = 5; y <= 8; y++) {
  for (let z = 6; z <= 10; z++) put(10, y, z, 'minecraft:oak_planks');
  for (let x = 10; x <= 14; x++) put(x, y, 6, 'minecraft:oak_planks');
}
for (const [y, half] of [[5, 'lower'], [6, 'upper']]) put(10, y, 8, `minecraft:oak_door[facing=east,half=${half},hinge=left,open=true,powered=false]`);
for (let y = 1; y <= 3; y++) {
  for (let z = 1; z <= 4; z++) put(12, y, z, 'minecraft:stone_bricks');
  for (let x = 12; x <= 14; x++) put(x, y, 4, 'minecraft:stone_bricks');
}
for (const [y, half] of [[1, 'lower'], [2, 'upper']]) put(12, y, 2, `minecraft:oak_door[facing=east,half=${half},hinge=left,open=false,powered=false]`);
put(9, 2, 2, 'minecraft:stone_bricks');
put(13, 5, 8, 'minecraft:oak_planks');
for (const x of [3, 4, 7, 8, 11, 12]) for (const y of [2, 3, 6, 7]) put(x, y, 11, 'minecraft:glass');

const names = [...new Set(cells)]; const palette = Object.fromEntries(names.map((name, i) => [name, { type: 'int', value: i }]));
const ids = new Map(names.map((name, i) => [name, i])); const data = [];
for (const name of cells) { let n = ids.get(name); do { let byte = n & 127; n >>>= 7; if (n) byte |= 128; data.push(byte > 127 ? byte - 256 : byte); } while (n); }
const root = { name: 'Schematic', type: 'compound', value: {
  Version: { type: 'int', value: 2 }, DataVersion: { type: 'int', value: 3465 },
  Width: { type: 'short', value: W }, Height: { type: 'short', value: H }, Length: { type: 'short', value: L },
  Offset: { type: 'intArray', value: [0, 0, 0] }, Palette: { type: 'compound', value: palette }, PaletteMax: { type: 'int', value: names.length }, BlockData: { type: 'byteArray', value: data }
} };
const inspection = {
  dimension: 'minecraft:overworld', bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 15, y: 10, z: 11 } },
  entry: { x: 2.5, y: 1, z: 8.5 }, floors: [{ id: 'ground', cutY: 2 }, { id: 'upper', cutY: 6 }],
  targets: [
    { id: 'living-room', floorId: 'ground', position: { x: 8.5, y: 1, z: 8.5 } },
    { id: 'upstairs-bedroom', floorId: 'upper', position: { x: 11.5, y: 5, z: 8.5 }, lookAt: { x: 13.5, y: 5.5, z: 8.5 } },
    { id: 'closed-closet', floorId: 'ground', position: { x: 13.5, y: 1, z: 2.5 } },
    { id: 'low-ceiling', floorId: 'ground', position: { x: 9.5, y: 1, z: 2.5 } }
  ]
};
await mkdir(output, { recursive: true });
const mapPath = join(output, 'two-floor-house.schem'), inspectionPath = join(output, 'inspection.json');
await writeFile(mapPath, gzipSync(nbt.writeUncompressed(root)));
await writeFile(inspectionPath, JSON.stringify(inspection, null, 2));
process.stdout.write(JSON.stringify({ mapPath, inspectionPath, expected: { 'living-room': 'reachable', 'upstairs-bedroom': 'reachable', 'closed-closet': 'unreachable_in_profile', 'low-ceiling': 'unreachable_in_profile' } }, null, 2) + '\n');
