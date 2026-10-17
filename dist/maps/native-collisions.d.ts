import type { BlockState, Shape } from './types.js';
export interface NativeCollisionData {
    version: string;
    fingerprint: string;
    defaults: Map<string, Record<string, string>>;
    states: Map<string, {
        shapes: Shape[] | null;
        reason?: string;
    }>;
    cases: any[];
}
export declare function registerCollisionDirectory(directory: string): void;
export declare function nativeCollisionData(version?: string): NativeCollisionData | undefined;
export declare function nativeStateKey(state: BlockState): string;
export declare function defaultBlockProperties(version: string | undefined, name: string): Record<string, string>;
