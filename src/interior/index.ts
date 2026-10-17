import { setImmediate as yieldNow } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { fail } from '../contracts.js';
import { bounds as parseBounds, point, type BlockSample, type Bounds, type CollisionResolver, type MapReader, type Point, type Shape } from '../maps/types.js';

export interface Inspection {
  dimension?: string; bounds: Bounds; entry: Point;
  floors: Array<{ id: string; cutY: number }>;
  targets: Array<{ id: string; floorId?: string; position: Point; lookAt?: Point }>;
  maxNodes?: number;
}
type Reason = { position: Point; block?: string; reason: string };
type PoseResult = { status: 'clear' | 'blocked' | 'unknown'; reason?: Reason };
const EPS = 0.00001;
const WIDTH = 0.6; const HEIGHT = 1.8; const STEP = 0.6; const GRID = 0.5;
function overlap(a: Shape, b: Shape): boolean { return a[0] < b[3] - EPS && a[3] > b[0] + EPS && a[1] < b[4] - EPS && a[4] > b[1] + EPS && a[2] < b[5] - EPS && a[5] > b[2] + EPS; }
function body(p: Point): Shape { return [p.x - WIDTH / 2, p.y + EPS, p.z - WIDTH / 2, p.x + WIDTH / 2, p.y + HEIGHT, p.z + WIDTH / 2]; }
function worldShape(block: BlockSample, s: Shape): Shape { const p = block.position; return [p.x + s[0], p.y + s[1], p.z + s[2], p.x + s[3], p.y + s[4], p.z + s[5]]; }
function key(p: Point): string { return `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)}`; }
function distance(a: Point, b: Point): number { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

export async function loadInspection(value: string | Inspection | any): Promise<Inspection> {
  if (typeof value === 'string') { try { value = JSON.parse((await readFile(value, 'utf8')).replace(/^\uFEFF/, '')); } catch (e) { fail('INVALID_INSPECTION', 'Cannot read inspection JSON', { reason: String(e) }); } }
  if (!value || typeof value !== 'object') fail('INVALID_INSPECTION', 'inspection must be a JSON file path or object');
  const b = parseBounds(value.bounds, undefined, 500_000); const entry = point(value.entry, 'entry');
  const inside = (p: Point): boolean => p.x >= b.min.x && p.x <= b.max.x + 1 && p.y >= b.min.y && p.y <= b.max.y + 1 && p.z >= b.min.z && p.z <= b.max.z + 1;
  if (!inside(entry)) fail('INVALID_INSPECTION', 'entry is outside inspection bounds');
  if (!Array.isArray(value.targets) || value.targets.length > 200) fail('INVALID_INSPECTION', 'targets must be an array of at most 200 named positions');
  const floors = (value.floors ?? []).map((f: any) => { if (typeof f.id !== 'string' || !f.id || !Number.isInteger(f.cutY) || f.cutY < b.min.y || f.cutY > b.max.y) fail('INVALID_INSPECTION', 'Each floor needs an id and an integer cutY inside bounds'); return { id: f.id, cutY: f.cutY }; });
  if (new Set(floors.map((f: any) => f.id)).size !== floors.length) fail('INVALID_INSPECTION', 'Floor IDs must be unique');
  const targets = value.targets.map((t: any) => {
    if (typeof t.id !== 'string' || !t.id) fail('INVALID_INSPECTION', 'Each target needs an id');
    const position = point(t.position, `target ${t.id}`); if (!inside(position)) fail('INVALID_INSPECTION', `Target ${t.id} is outside bounds`);
    if (t.floorId && !floors.some((f: any) => f.id === t.floorId)) fail('INVALID_INSPECTION', `Unknown floor ${t.floorId}`);
    return { id: t.id, floorId: t.floorId, position, ...(t.lookAt ? { lookAt: point(t.lookAt, 'lookAt') } : {}) };
  });
  if (new Set(targets.map((t: any) => t.id)).size !== targets.length) fail('INVALID_INSPECTION', 'Target IDs must be unique');
  if (value.maxNodes !== undefined && (!Number.isInteger(value.maxNodes) || value.maxNodes < 1 || value.maxNodes > 100_000)) fail('INVALID_INSPECTION', 'maxNodes must be between 1 and 100000');
  return { dimension: value.dimension, bounds: b, entry, floors, targets, maxNodes: value.maxNodes ?? 30_000 };
}

/** Bounded, collision-aware walking search. It intentionally does not claim an in-game visit. */
export async function checkInterior(reader: MapReader, resolver: CollisionResolver, input: Inspection, floorCapture?: (floor: { id: string; cutY: number }, bounds: Bounds) => Promise<any>, options: {signal?:AbortSignal} = {}): Promise<any> {
  if(options.signal?.aborted)fail('CANCELLED','Interior inspection cancelled');
  const inspection = await loadInspection(input); const b = inspection.bounds;
  if (inspection.dimension && inspection.dimension !== reader.dimension) fail('DIMENSION_MISMATCH', `Map session uses ${reader.dimension}; inspection requests ${inspection.dimension}`);
  const blocks = new Map<string, Promise<BlockSample>>(); const poseCache = new Map<string, PoseResult>();
  const get = (x: number, y: number, z: number): Promise<BlockSample> => { const k = `${x},${y},${z}`; if (!blocks.has(k)) blocks.set(k, resolver.sample(reader, x, y, z)); return blocks.get(k)!; };
  const reason = (block: BlockSample, text: string): Reason => ({ position: block.position, block: block.name, reason: text });
  async function evaluate(p: Point, requireSupport = true): Promise<PoseResult> {
    const pk = key(p); if (requireSupport && poseCache.has(pk)) return poseCache.get(pk)!;
    const box = body(p); let unknown: Reason | undefined; let blocked: Reason | undefined;
    if (box[0] < b.min.x - EPS || box[3] > b.max.x + 1 + EPS || box[2] < b.min.z - EPS || box[5] > b.max.z + 1 + EPS || p.y < b.min.y || box[4] > b.max.y + 1 + EPS) return { status: 'blocked', reason: { position: p, reason: 'player-body-outside-inspection-bounds' } };
    // Include one lower block because fences/walls can have shapes higher than one block.
    for (let x = Math.floor(box[0] + EPS); x <= Math.floor(box[3] - EPS); x++) for (let z = Math.floor(box[2] + EPS); z <= Math.floor(box[5] - EPS); z++) for (let y = Math.floor(p.y) - 1; y <= Math.floor(box[4] - EPS); y++) {
      const block = await get(x, y, z);
      if (!block.known || block.shapes === null) { unknown ??= reason(block, block.reason ?? 'unknown-collision'); continue; }
      if (block.specialMovement && y + 1 > p.y + EPS && y < box[4] - EPS) unknown ??= reason(block, `unsupported-movement:${block.specialMovement}`);
      for (const s of block.shapes) if (overlap(box, worldShape(block, s))) blocked ??= reason(block, y >= p.y + HEIGHT / 2 ? 'insufficient-headroom' : 'player-collision');
    }
    if (blocked) { const r: PoseResult = { status: 'blocked', reason: blocked }; if (requireSupport) poseCache.set(pk, r); return r; }
    if (requireSupport) {
      let supported = false; let unknownSupport: Reason | undefined;
      for (let x = Math.floor(box[0] + EPS); x <= Math.floor(box[3] - EPS); x++) for (let z = Math.floor(box[2] + EPS); z <= Math.floor(box[5] - EPS); z++) for (let y = Math.floor(p.y) - 2; y <= Math.floor(p.y); y++) {
        const block = await get(x, y, z);
        if (!block.known || block.shapes === null) { unknownSupport ??= reason(block, 'unknown-support'); continue; }
        for (const s of block.shapes) { const w = worldShape(block, s); if (Math.abs(w[4] - p.y) < EPS && w[0] < box[3] - EPS && w[3] > box[0] + EPS && w[2] < box[5] - EPS && w[5] > box[2] + EPS) supported = true; }
      }
      if (!supported) { const r: PoseResult = unknownSupport ? { status: 'unknown', reason: unknownSupport } : { status: 'blocked', reason: { position: p, reason: 'no-supporting-surface' } }; poseCache.set(pk, r); return r; }
    }
    const r: PoseResult = unknown ? { status: 'unknown', reason: unknown } : { status: 'clear' }; if (requireSupport) poseCache.set(pk, r); return r;
  }
  async function heights(x: number, z: number, fromY: number): Promise<{ ys: number[]; unknown?: Reason }> {
    const ys = new Set<number>(); let unknown: Reason | undefined;
    for (let bx = Math.floor(x - WIDTH / 2 + EPS); bx <= Math.floor(x + WIDTH / 2 - EPS); bx++) for (let bz = Math.floor(z - WIDTH / 2 + EPS); bz <= Math.floor(z + WIDTH / 2 - EPS); bz++) for (let by = Math.floor(fromY - STEP) - 2; by <= Math.floor(fromY + STEP); by++) {
      const block = await get(bx, by, bz);
      if (!block.known || block.shapes === null) { if (by >= Math.floor(fromY) - 1) unknown ??= reason(block, 'unknown-neighbor-surface'); continue; }
      for (const s of block.shapes) { const top = by + s[4]; if (top >= fromY - STEP - EPS && top <= fromY + STEP + EPS && bx + s[0] < x + WIDTH / 2 - EPS && bx + s[3] > x - WIDTH / 2 + EPS && bz + s[2] < z + WIDTH / 2 - EPS && bz + s[5] > z - WIDTH / 2 + EPS) ys.add(top); }
    }
    return { ys: [...ys].sort((a, c) => Math.abs(a - fromY) - Math.abs(c - fromY)), unknown };
  }
  async function transition(a: Point, c: Point): Promise<PoseResult> {
    const high = Math.max(a.y, c.y);
    // The step-up clearance must exist at the source, and throughout the horizontal sweep.
    if (c.y > a.y + EPS) for (let y = a.y + 0.1; y < high + 0.05; y += 0.1) { const r = await evaluate({ ...a, y: Math.min(y, high) }, false); if (r.status !== 'clear') return r; }
    for (let i = 1; i <= 5; i++) { const r = await evaluate({ x: a.x + (c.x - a.x) * i / 5, y: high, z: a.z + (c.z - a.z) * i / 5 }, false); if (r.status !== 'clear') return r; }
    if (c.y < a.y - EPS) for (let y = high - 0.1; y > c.y - 0.05; y -= 0.1) { const r = await evaluate({ ...c, y: Math.max(y, c.y) }, false); if (r.status !== 'clear') return r; }
    return { status: 'clear' };
  }
  const entryResult = await evaluate(inspection.entry); const queue: Point[] = []; const parents = new Map<string, string | null>(); const visited = new Map<string, Point>();
  const unknowns: Reason[] = []; const blockers: Reason[] = []; let cursor = 0; let exhausted = false;
  if (entryResult.status === 'clear') { queue.push(inspection.entry); parents.set(key(inspection.entry), null); visited.set(key(inspection.entry), inspection.entry); }
  else if (entryResult.status === 'unknown' && entryResult.reason) unknowns.push(entryResult.reason);
  else if (entryResult.reason) blockers.push(entryResult.reason);
  while (cursor < queue.length) {
    if(options.signal?.aborted)fail('CANCELLED','Interior inspection cancelled');if(cursor%128===0)await yieldNow();
    if (visited.size >= inspection.maxNodes!) { exhausted = true; break; }
    const current = queue[cursor++];
    for (const [dx, dz] of [[GRID, 0], [-GRID, 0], [0, GRID], [0, -GRID]]) {
      const x = current.x + dx; const z = current.z + dz;
      if (x - WIDTH / 2 < b.min.x - EPS || x + WIDTH / 2 > b.max.x + 1 + EPS || z - WIDTH / 2 < b.min.z - EPS || z + WIDTH / 2 > b.max.z + 1 + EPS) continue;
      const surfaces = await heights(x, z, current.y); let clearSurface = false;
      for (const y of surfaces.ys) {
        const next = { x, y, z }; const nk = key(next); if (visited.has(nk)) { clearSurface = true; continue; }
        const pose = await evaluate(next);
        if (pose.status === 'unknown') { if (unknowns.length < 200 && pose.reason) unknowns.push(pose.reason); continue; }
        if (pose.status === 'blocked') { if (blockers.length < 2000 && pose.reason) blockers.push(pose.reason); continue; }
        const movement = await transition(current, next);
        if (movement.status !== 'clear') { if (movement.reason && movement.status === 'unknown' && unknowns.length < 200) unknowns.push(movement.reason); else if (movement.reason && blockers.length < 2000) blockers.push(movement.reason); continue; }
        clearSurface = true; queue.push(next); visited.set(nk, next); parents.set(nk, key(current));
      }
      if (!clearSurface && surfaces.unknown && unknowns.length < 200) unknowns.push(surfaces.unknown);
    }
  }
  const reconstruct = (end: Point): Point[] => { const path: Point[] = []; let k: string | null = key(end); while (k) { path.push(visited.get(k)!); k = parents.get(k) ?? null; } return path.reverse(); };
  const targets = [];
  for (const target of inspection.targets) {
    const exact = await evaluate(target.position); let endpoint: Point | undefined;
    if (exact.status === 'clear') {
      for (const candidate of visited.values()) if (distance(candidate, target.position) < 0.36 && Math.abs(candidate.y - target.position.y) < 0.01) {
        if ((await transition(candidate, target.position)).status === 'clear') { endpoint = candidate; break; }
      }
    }
    let status: 'reachable' | 'unreachable_in_profile' | 'unknown'; let failure: Reason | undefined;
    if (endpoint) status = 'reachable';
    else if (entryResult.status === 'unknown') { status = 'unknown'; failure = entryResult.reason; }
    else if (exact.status === 'unknown') { status = 'unknown'; failure = exact.reason; }
    else if (entryResult.status === 'blocked' || exact.status === 'blocked') { status = 'unreachable_in_profile'; failure = exact.reason ?? entryResult.reason; }
    else if (exhausted || unknowns.length) { status = 'unknown'; failure = exhausted ? { position: target.position, reason: 'search-node-budget-exceeded' } : unknowns.reduce((a, c) => distance(a.position, target.position) < distance(c.position, target.position) ? a : c); }
    else { status = 'unreachable_in_profile'; failure = blockers.length ? blockers.reduce((a, c) => distance(a.position, target.position) < distance(c.position, target.position) ? a : c) : { position: target.position, reason: 'no-path-in-bounded-discretized-walking-profile' }; }
    const path = endpoint ? reconstruct(endpoint) : [];
    if (endpoint && distance(endpoint, target.position) > EPS) path.push(target.position);
    targets.push({ ...target, status, statusLabel: status === 'reachable' ? '도달 가능' : status === 'unknown' ? '판정 불가' : '현재 보행 조건에서 실패', ...(failure ? { failure } : {}), path, actualVisit: { status: 'not_attempted', reason: 'Static map analysis does not verify an in-game visit.' } });
  }
  const images = floorCapture ? await Promise.all(inspection.floors.map(f => floorCapture(f, b))) : [];
  return { profile: { width: WIDTH, height: HEIGHT, maxStepUp: STEP, maxStepDown: STEP, gridSpacing: GRID, doors: 'current-state', jumping: false, breakOrPlaceBlocks: false, specialMovement: 'unknown', constraint: 'paths must stay within inspection bounds; this is static geometric analysis' }, limitations: ['Half-block horizontal sampling may miss narrow passages offset from the search grid. Unreachable describes this bounded walking profile; unusual geometry should be confirmed in game.'], dimension: reader.dimension, bounds: b, entry: { position: inspection.entry, ...entryResult }, floors: images, targets, unvisited: targets.filter(t => t.status !== 'reachable').map(t => t.id), search: { visitedNodes: visited.size, examinedBlocks: blocks.size, exhausted, unknownFrontiers: unknowns.slice(0, 20) }, actualVisitVerified: false };
}
