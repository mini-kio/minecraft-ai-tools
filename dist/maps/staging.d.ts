import { type Bounds, type Point } from './types.js';
export interface StageOptions {
    version: string;
    dimension?: string;
    bounds?: Bounds;
    workDir: string;
    signal?: AbortSignal;
    maxVolume?: number;
    maxCommands?: number;
}
export interface SourceHash {
    path: string;
    sha256: string;
}
export interface MapStagePlan {
    kind: 'block-import' | 'region-copy';
    source: string;
    version: string;
    dimension: string;
    bounds: Bounds;
    origin: Point;
    focus: Point;
    copiedWorldPath?: string;
    serverProperties: Record<string, string>;
    commands: string[];
    blockCount: number;
    blockEntities: number;
    sourceHashes: SourceHash[];
    planPath: string;
    warnings: string[];
    entityCount?: number;
    entityTreeCount?: number;
    entityTag?: string;
    entityUuids?: string[];
    excludedEntities?: number;
    uuidRemap?: Record<string, string>;
}
export interface ApplyStageOptions {
    sendCommand: (command: string) => Promise<unknown>;
    readLogs: () => Promise<any>;
    signal?: AbortSignal;
    timeoutMs?: number;
}
export declare function verifyStageSources(plan: MapStagePlan, signal?: AbortSignal): Promise<void>;
/** Serialize the original typed NBT rather than guessing number widths from simplified JSON. */
export declare function typedNbtToSnbt(tag: any, mixedLists?: boolean): string;
export declare function prepareMapStage(sourcePath: string, options: StageOptions): Promise<MapStagePlan>;
export declare function applyMapStage(plan: MapStagePlan, options: ApplyStageOptions): Promise<any>;
