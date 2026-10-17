import { setTimeout as sleep } from 'node:timers/promises';
import { Args, fail } from './contracts.js';
import { BridgeService } from './bridges.js';
import { inspectNative } from './native-interior.js';

export class NativeNavigation {
  private active = new Map<string, AbortController>();
  private scanning = new Map<string, AbortController>();
  constructor(private bridges: BridgeService, private artifactDir: string) {}
  cancel(client: string) { this.active.get(client)?.abort(); this.scanning.get(client)?.abort(); }
  async move(client: string, args: Args) {
    if (this.active.has(client) || this.scanning.has(client)) fail('SESSION_BUSY', 'A navigation job is already running');
    const controller = new AbortController(); this.scanning.set(client, controller);
    const abort = () => controller.abort(); args.signal?.addEventListener('abort',abort,{once:true}); if(args.signal?.aborted)controller.abort();
    const timeout = Number(args.timeoutMs || 30000);
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120000) { this.scanning.delete(client); fail('INVALID_ARGUMENT', 'Navigation timeout must be 1..120000ms'); }
    const deadline = Date.now() + timeout;
    try {
    const first = await this.bridges.request(client, 'observe', {}), start = first.player, target = args.target || args.position;
    if (!first.connected || !start) fail('NOT_CONNECTED', 'Client must be in a loaded world');
    if(first.screen || first.loading)fail('CLIENT_NOT_PLAYABLE','Wait for world loading to finish and close open screens before walking');
    if (!target || ['x','y','z'].some(k => !Number.isFinite(target[k]))) fail('INVALID_ARGUMENT', 'A finite target position is required');
    const bounds = args.bounds || { min: { x: Math.floor(Math.min(start.x,target.x))-3, y: Math.floor(Math.min(start.y,target.y))-2, z: Math.floor(Math.min(start.z,target.z))-3 }, max: { x: Math.ceil(Math.max(start.x,target.x))+3, y: Math.ceil(Math.max(start.y,target.y))+3, z: Math.ceil(Math.max(start.z,target.z))+3 } };
    const inspection = { dimension: first.dimension || start.dimension, bounds, entry: { x:start.x,y:start.y,z:start.z }, floors: [], targets: [{ id: 'destination', position: target }] };
    const report = await inspectNative(this.bridges, { client, inspection, signal: controller.signal, deadline }, this.artifactDir);
    if (controller.signal.aborted) fail('CANCELLED', 'Navigation cancelled during collision scanning');
    if (Date.now() >= deadline) fail('TIMEOUT', 'Collision scanning exceeded navigation deadline');
    const destination = report.targets[0];
    if (destination.status !== 'reachable') fail(destination.status === 'unknown' ? 'PATH_UNKNOWN' : 'NO_WALKING_PATH', 'No confirmed walking route to target in the scanned bounds', { target: destination, reportPath: report.reportPath });
    this.scanning.delete(client);
    return await this.follow(client, destination.path, { ...args, timeoutMs: deadline - Date.now() });
    } finally { this.scanning.delete(client); args.signal?.removeEventListener('abort',abort); }
  }
  async follow(client: string, path: Array<{ x:number;y:number;z:number }>, args: Args = {}) {
    if (this.active.has(client)) fail('SESSION_BUSY', 'A navigation job is already running');
    if (!path.length) fail('NO_WALKING_PATH', 'No path supplied');
    const controller = new AbortController(); this.active.set(client,controller);
    const abort = () => controller.abort(); args.signal?.addEventListener('abort',abort,{once:true}); if(args.signal?.aborted)controller.abort();
    const timeout = Number(args.timeoutMs || 30000); if (!Number.isFinite(timeout) || timeout<1 || timeout>120000) { this.active.delete(client); fail('INVALID_ARGUMENT', 'Navigation timeout must be 1..120000ms'); }
    const started = Date.now(); let latest: any, best = Infinity, lastProgress=Date.now();
    try {
      for (let index=1;index<path.length;index++) {
        const goal = path[index]; best=Infinity;lastProgress=Date.now();
        for (;;) {
          if (controller.signal.aborted) fail('CANCELLED', 'Navigation cancelled');
          if (Date.now()-started>timeout) fail('TIMEOUT', 'Navigation exceeded deadline', { at: latest?.player, target: goal });
          latest=await this.bridges.request(client,'observe',{}); const p=latest.player;
          if(!latest.connected||!p)fail('NOT_CONNECTED','Client disconnected during navigation');
          if(latest.screen || latest.loading)fail('CLIENT_NOT_PLAYABLE','Client opened a screen or began loading during navigation');
          const distance=Math.hypot(p.x-goal.x,p.z-goal.z), vertical=Math.abs(p.y-goal.y);
          if(distance<=0.32&&vertical<=0.65)break;
          if(distance<best-0.03){best=distance;lastProgress=Date.now();}
          if(Date.now()-lastProgress>2500)fail('PATH_BLOCKED','Client stopped making progress',{position:p,target:goal});
          const dx=goal.x-p.x,dz=goal.z-p.z;
          await this.bridges.request(client,'look',{yaw:Math.atan2(-dx,dz),pitch:0});
          await this.bridges.request(client,'input',{key:'forward',action:'press',durationMs:100});
          await sleep(90);
        }
      }
      latest=await this.bridges.request(client,'observe',{}); const final=path[path.length-1],p=latest.player;
      if(!p||Math.hypot(p.x-final.x,p.y-final.y,p.z-final.z)>0.8)fail('TARGET_NOT_REACHED','Client did not physically arrive',{actual:p,target:final});
      return {...latest,reached:true,liveVerified:true,profile:'ground-walk',target:final,inputsReleased:true};
    } finally { this.active.delete(client); args.signal?.removeEventListener('abort',abort); await this.bridges.request(client,'stop',{}).catch(()=>{}); }
  }
  close() { for(const controller of [...this.active.values(), ...this.scanning.values()])controller.abort(); }
}
