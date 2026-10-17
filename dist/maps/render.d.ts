import { CollisionResolver, type BlockSample, type Bounds, type MapReader, type Point } from './types.js';
export declare function blockColor(name: string): [number, number, number];
export declare function renderSlice(reader: MapReader, resolver: CollisionResolver, options: {
    bounds: Bounds;
    axis: 'x' | 'y' | 'z';
    at: number;
    scale?: number;
    projection?: 'slice' | 'floor';
    marker?: Point;
    signal?: AbortSignal;
}, artifactDir: string): Promise<any>;
export declare function renderIsometric(blocks: BlockSample[], b: Bounds, artifactDir: string, signal?: AbortSignal): Promise<any>;
