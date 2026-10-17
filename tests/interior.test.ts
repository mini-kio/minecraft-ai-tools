import test from 'node:test';
import assert from 'node:assert/strict';
import { checkInterior, loadInspection } from '../src/interior/index.js';
import { AIR, CollisionResolver, state, type BlockState, type Bounds, type MapReader } from '../src/maps/types.js';

class Room implements MapReader {
  path = 'memory'; kind = 'test'; dimension = 'minecraft:overworld'; version = '1.20.1'; warnings: string[] = []; cells = new Map<string, BlockState | null>();
  bounds: Bounds = { min: { x: 0, y: 0, z: 0 }, max: { x: 6, y: 6, z: 6 } };
  constructor() { for (let x = 0; x < 7; x++) for (let z = 0; z < 7; z++) this.put(x, 0, z, 'minecraft:stone'); }
  put(x: number, y: number, z: number, s: string | null): void { this.cells.set(`${x},${y},${z}`, s === null ? null : state(s)); }
  async getBlock(x: number, y: number, z: number): Promise<BlockState | null> { if (x < 0 || y < 0 || z < 0 || x > 6 || y > 6 || z > 6) return null; return this.cells.has(`${x},${y},${z}`) ? this.cells.get(`${x},${y},${z}`)! : AIR; }
  metadata(): any { return {}; } async changed(): Promise<boolean> { return false; } async close(): Promise<void> {}
}
const resolver = new CollisionResolver('1.20.1');
const plan = (room: Room, target = { x: 5.5, y: 1, z: 3.5 }): any => ({ bounds: room.bounds, entry: { x: 1.5, y: 1, z: 3.5 }, floors: [], targets: [{ id: 'room', position: target }] });

test('normal room yields a collision-clear walking path and never claims an actual visit', async () => {
  const room = new Room(); const report = await checkInterior(room, resolver, plan(room)); assert.equal(report.targets[0].status, 'reachable'); assert.ok(report.targets[0].path.length > 1); assert.equal(report.actualVisitVerified, false); assert.equal(report.targets[0].actualVisit.status, 'not_attempted');
});
test('low ceiling reports headroom coordinates rather than an unreachable claim without evidence', async () => {
  const room = new Room(); room.put(5, 2, 3, 'minecraft:stone'); const report = await checkInterior(room, resolver, plan(room)); assert.equal(report.targets[0].status, 'unreachable_in_profile'); assert.equal(report.targets[0].failure.reason, 'insufficient-headroom'); assert.deepEqual(report.targets[0].failure.position, { x: 5, y: 2, z: 3 });
});
test('sealed room is unreachable in walking profile', async () => {
  const room = new Room(); for (let z = 0; z <= 6; z++) for (let y = 1; y <= 6; y++) room.put(3, y, z, 'minecraft:stone');
  const report = await checkInterior(room, resolver, plan(room)); assert.equal(report.targets[0].status, 'unreachable_in_profile'); assert.ok(report.targets[0].failure.position);
});
for (const open of [false, true]) test(`door open=${open} uses its actual rotated collision state`, async () => {
  const room = new Room(); for (let z = 0; z <= 6; z++) for (let y = 1; y <= 6; y++) if (!(z === 3 && y < 3)) room.put(3, y, z, 'minecraft:stone');
  for (const [y, half] of [[1, 'lower'], [2, 'upper']] as const) room.put(3, y, 3, `minecraft:oak_door[facing=east,half=${half},hinge=left,open=${open},powered=false]`);
  const report = await checkInterior(room, resolver, plan(room)); assert.equal(report.targets[0].status, open ? 'reachable' : 'unreachable_in_profile');
});
test('slab and stair surfaces allow successive half-block steps; a removed first stair breaks the route', async () => {
  for (const broken of [false, true]) {
    const room = new Room(); for (let x = 0; x <= 6; x++) for (let y = 1; y <= 6; y++) for (const z of [0, 2, 3, 4, 5, 6]) room.put(x, y, z, 'minecraft:stone');
    if (!broken) room.put(3, 1, 1, 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]');
    room.put(4, 2, 1, 'minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]');
    for (const x of [5, 6]) room.put(x, 2, 1, 'minecraft:stone');
    const inspection = plan(room, { x: 5.5, y: 3, z: 1.5 }); inspection.entry = { x: 1.5, y: 1, z: 1.5 };
    const report = await checkInterior(room, resolver, inspection); assert.equal(report.targets[0].status, broken ? 'unreachable_in_profile' : 'reachable', JSON.stringify(report.targets[0]));
  }
});
test('missing chunks, custom blocks and water are unknown rather than assumed empty or solid', async () => {
  for (const value of [null, 'custom:machine', 'minecraft:water[level=0]']) {
    const room = new Room(); room.put(5, 1, 3, value); const report = await checkInterior(room, resolver, plan(room)); assert.equal(report.targets[0].status, 'unknown'); assert.ok(report.targets[0].failure.position);
  }
});
test('invalid or ambiguous inspection inputs fail early', async () => {
  const room = new Room(); const p = plan(room); p.targets.push(p.targets[0]); await assert.rejects(() => loadInspection(p), /unique/);
  await assert.rejects(() => checkInterior(room, resolver, { ...plan(room), dimension: 'minecraft:the_nether' }), (e: any) => e.code === 'DIMENSION_MISMATCH');
});
