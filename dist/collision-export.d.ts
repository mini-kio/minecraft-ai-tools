import { BridgeService } from './bridges.js';
import { type Args } from './contracts.js';
/** Acquire exact registry data from the user's matching game, without a version downgrade. */
export declare function exportCollisionData(bridges: BridgeService, directory: string, args: Args): Promise<any>;
