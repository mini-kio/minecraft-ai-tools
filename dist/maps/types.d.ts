export type Point = {
    x: number;
    y: number;
    z: number;
};
export type Bounds = {
    min: Point;
    max: Point;
};
export type Shape = [number, number, number, number, number, number];
export interface BlockState {
    name: string;
    properties: Record<string, string>;
}
export interface MapEntity {
    id: string;
    position: Point;
    blockPosition?: Point;
    rotation?: number[];
    uuid?: string;
    nbt: Record<string, any>;
    passengers: MapEntity[];
}
export interface MapBlockEntity {
    id: string;
    position: Point;
    nbt: Record<string, any>;
}
export interface MapEnvironment {
    known: boolean;
    biome?: string;
    light?: {
        sky?: number;
        block?: number;
    };
    reason?: string;
}
export interface BlockSample extends BlockState {
    position: Point;
    known: boolean;
    reason?: string;
    shapes: Shape[] | null;
    collisionSource: string;
    specialMovement?: string;
    environment?: MapEnvironment;
}
export interface MapReader {
    path: string;
    kind: string;
    dimension: string;
    bounds: Bounds;
    version?: string;
    dataVersion?: number;
    warnings: string[];
    getBlock(x: number, y: number, z: number): Promise<BlockState | null>;
    getEntities?(bounds: Bounds, signal?: AbortSignal): Promise<MapEntity[]>;
    getBlockEntities?(bounds: Bounds, signal?: AbortSignal): Promise<MapBlockEntity[]>;
    getEnvironment?(x: number, y: number, z: number): Promise<MapEnvironment>;
    metadata(): Record<string, any>;
    changed(): Promise<boolean>;
    close(): Promise<void>;
}
export declare const AIR: BlockState;
export declare function point(value: any, name?: string): Point;
export declare function bounds(value: any, fallback?: Bounds, limit?: number): Bounds;
export declare function volume(b: Bounds): number;
export declare function contains(b: Bounds, p: Point): boolean;
export declare function state(text: any): BlockState;
export declare function stateString(s: BlockState): string;
/** Collision shapes are resolved from the selected Java version, never guessed as full cubes. */
export declare class CollisionResolver {
    version?: string | undefined;
    private Block;
    private data;
    private native?;
    private cache;
    constructor(version?: string | undefined);
    get available(): boolean;
    normalize(s: BlockState): BlockState;
    describe(s: BlockState): Pick<BlockSample, 'shapes' | 'collisionSource' | 'specialMovement'>;
    sample(reader: MapReader, x: number, y: number, z: number): Promise<BlockSample>;
}
