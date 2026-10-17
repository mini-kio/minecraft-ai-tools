import { setImmediate as yieldNow } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, id, required, type Args, type Service, type ServiceOptions } from '../contracts.js';
import { checkInterior, loadInspection } from '../interior/index.js';
import { openMap } from './readers.js';
import { renderIsometric, renderSlice } from './render.js';
import { bounds, CollisionResolver, point, type BlockSample, type Bounds, type MapReader } from './types.js';

interface Session { id: string; reader: MapReader; resolver: CollisionResolver; openedAt: string; camera: Record<string, any>; options: { version?: string; dimension?: string }; }
export class MapService implements Service {
  private sessions = new Map<string, Session>();
  constructor(private options: ServiceOptions) {}
  private session(args: Args): Session { const session = this.sessions.get(required(args.session, 'session')); if (!session) fail('SESSION_NOT_FOUND', `Unknown map session: ${args.session}`); return session; }
  private async describe(s: Session): Promise<any> { return { session: s.id, type: 'map', path: s.reader.path, format: s.reader.kind, dimension: s.reader.dimension, version: s.reader.version ?? null, dataVersion: s.reader.dataVersion ?? null, bounds: s.reader.bounds, changed: await s.reader.changed(), camera: s.camera, collisionAvailable: s.resolver.available, warnings: s.reader.warnings, source: s.reader.metadata(), transport: 'read-only-local-file', observedAt: new Date().toISOString() }; }
  private selectedBounds(s: Session, args: Args, max = 200_000): Bounds {
    if (args.bounds) return bounds(args.bounds, undefined, max);
    const b = s.reader.bounds; const size = (b.max.x - b.min.x + 1) * (b.max.y - b.min.y + 1) * (b.max.z - b.min.z + 1);
    if (size > max) fail('BOUNDS_REQUIRED', 'This source is large. Provide inclusive integer bounds for a bounded read.', { sourceBounds: b, maximumBlocks: max });
    return bounds(b, undefined, max);
  }
  private async blocks(s: Session, b: Bounds, includeAir = false, signal?:AbortSignal): Promise<{ blocks: BlockSample[]; unknownCount: number }> {
    const result: BlockSample[] = []; let unknownCount = 0;
    for (let y = b.min.y; y <= b.max.y; y++) for (let z = b.min.z; z <= b.max.z; z++) for (let x = b.min.x; x <= b.max.x; x++) { if(signal?.aborted)fail('CANCELLED','Map read cancelled');if((x-b.min.x)%128===0)await yieldNow();const block = await s.resolver.sample(s.reader, x, y, z); if (!block.known) unknownCount++; if (includeAir || !/:(air|cave_air|void_air)$/.test(block.name)){if(s.reader.getEnvironment)block.environment=await s.reader.getEnvironment(x,y,z);result.push(block);} }
    return { blocks: result, unknownCount };
  }
  async call(action: string, args: Args): Promise<any> {
    if(args.signal?.aborted)fail('CANCELLED','Map operation cancelled');
    if (action === 'open') {
      const options = { version: args.version, dimension: args.dimension }; const reader = await openMap(required(args.path, 'path'), options);
      if(args.signal?.aborted){await reader.close();fail('CANCELLED','Map open cancelled');}
      const s: Session = { id: id('map'), reader, resolver: new CollisionResolver(reader.version), openedAt: new Date().toISOString(), camera: { mode: 'orbit' }, options };
      this.sessions.set(s.id, s); return this.describe(s);
    }
    if (action === 'list') return Promise.all([...this.sessions.values()].map(s => this.describe(s)));
    const s = this.session(args);
    if (action === 'close') { await s.reader.close(); this.sessions.delete(s.id); return { session: s.id, closed: true }; }
    if (action === 'reload') { const reader = await openMap(s.reader.path, { ...s.options, ...(args.dimension ? { dimension: args.dimension } : {}), ...(args.version ? { version: args.version } : {}) }); await s.reader.close(); s.reader = reader; s.resolver = new CollisionResolver(reader.version); s.options = { version: args.version ?? s.options.version, dimension: args.dimension ?? s.options.dimension }; return this.describe(s); }
    if (action === 'camera') { if (args.position) s.camera.position = point(args.position); if (args.target) s.camera.target = point(args.target, 'target'); if (args.mode) { if (!['orbit', 'first-person'].includes(args.mode)) fail('INVALID_ARGUMENT', 'camera mode must be orbit or first-person'); s.camera.mode = args.mode; } return { ...(await this.describe(s)), camera: s.camera }; }
    if (action === 'observe' && !args.bounds && !args.position) return this.describe(s);
    if (action === 'inspect' || action === 'observe') {
      if (args.position) { const p = point(args.position); return { ...(await this.describe(s)), block: await s.resolver.sample(s.reader, p.x, p.y, p.z) }; }
      const b = this.selectedBounds(s, args, 65_536); const result = await this.blocks(s, b, Boolean(args.includeAir),args.signal); return { ...(await this.describe(s)), bounds: b, ...result };
    }
    if (action === 'viewer-data') { const b = this.selectedBounds(s, args); return { ...(await this.describe(s)), bounds: b, ...(await this.blocks(s, b,false,args.signal)),entities:await s.reader.getEntities?.(b,args.signal)??[],blockEntities:await s.reader.getBlockEntities?.(b,args.signal)??[],fidelity:{entityData:s.reader.getEntities?'source-nbt':'unavailable',entityRendering:'inspectable proxies; exact game rendering requires native capture',lighting:s.reader.getEnvironment?'saved-source-values-or-explicit-unknown':'unavailable'}, rendering: { source: 'prismarine-block-state-collision-boxes', accuracy: 'approximate', limitations: ['separate preview lighting and entity proxies are not the native game renderer'], interactive: true } }; }
    if (action === 'slice' || (action === 'capture' && (args.axis || args.mode === 'slice' || args.view === 'slice' || args.projection === 'floor'))) {
      const axis = args.axis ?? 'y'; if (!['x', 'y', 'z'].includes(axis)) fail('INVALID_ARGUMENT', 'axis must be x, y, or z');
      const b = this.selectedBounds(s, args); const at = args.at === undefined ? b.max[axis as 'x' | 'y' | 'z'] : Number(args.at); if (!Number.isInteger(at)) fail('INVALID_ARGUMENT', 'at must be an integer block coordinate');
      if (at < b.min[axis as 'x' | 'y' | 'z'] || at > b.max[axis as 'x' | 'y' | 'z']) fail('INVALID_ARGUMENT', 'at must be inside the selected bounds along the slice axis');
      if (args.scale !== undefined && (!Number.isInteger(Number(args.scale)) || Number(args.scale) < 2 || Number(args.scale) > 24)) fail('INVALID_ARGUMENT', 'scale must be an integer from 2 to 24 pixels per block');
      if (args.projection !== undefined && !['slice', 'floor'].includes(args.projection)) fail('INVALID_ARGUMENT', 'projection must be slice or floor');
      if (args.projection === 'floor' && axis !== 'y') fail('INVALID_ARGUMENT', 'floor projection requires axis y');
      return { ...(await this.describe(s)), ...(await renderSlice(s.reader, s.resolver, { bounds: b, axis, at, scale: args.scale, signal:args.signal,projection: args.projection ?? (axis === 'y' ? 'floor' : 'slice') }, this.options.artifactDir)) };
    }
    if (action === 'capture') { const b = this.selectedBounds(s, args, 80_000); const result = await this.blocks(s, b,false,args.signal); return { ...(await this.describe(s)), ...(await renderIsometric(result.blocks, b, this.options.artifactDir,args.signal)), unknownCount: result.unknownCount }; }
    if (action === 'interior-check') {
      const inspection = await loadInspection(required(args.inspection ?? args.plan ?? args.path, 'inspection'));
      const report = await checkInterior(s.reader, s.resolver, inspection, async (floor, b) => ({ ...floor, ...(await renderSlice(s.reader, s.resolver, { bounds: b, axis: 'y', at: floor.cutY, projection: 'floor', marker: inspection.entry,signal:args.signal }, this.options.artifactDir)) }),{signal:args.signal});
      await mkdir(this.options.artifactDir, { recursive: true }); const reportPath = join(this.options.artifactDir, `${id('interior_report')}.json`);
      const output = { ...(await this.describe(s)), ...report, reportPath }; await writeFile(reportPath, JSON.stringify(output, null, 2)); return output;
    }
    fail('UNKNOWN_ACTION', `Unknown map action: ${action}`);
  }
  async close(): Promise<void> { await Promise.all([...this.sessions.values()].map(s => s.reader.close())); this.sessions.clear(); }
}
