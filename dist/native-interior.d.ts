import { BridgeService } from './bridges.js';
import { Args } from './contracts.js';
/** Snapshot actual client collision shapes, without guessing newer-version block geometry. */
export declare function inspectNative(bridges: BridgeService, args: Args, artifactDir: string): Promise<any>;
