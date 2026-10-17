import { type MapReader } from './types.js';
export declare function readTypedMapNbt(path: string): Promise<any>;
export declare function openMap(path: string, options?: {
    version?: string;
    dimension?: string;
}): Promise<MapReader>;
