import { type Bounds, type CollisionResolver, type MapReader, type Point } from '../maps/types.js';
export interface Inspection {
    dimension?: string;
    bounds: Bounds;
    entry: Point;
    floors: Array<{
        id: string;
        cutY: number;
    }>;
    targets: Array<{
        id: string;
        floorId?: string;
        position: Point;
        lookAt?: Point;
    }>;
    maxNodes?: number;
}
export declare function loadInspection(value: string | Inspection | any): Promise<Inspection>;
/** Bounded, collision-aware walking search. It intentionally does not claim an in-game visit. */
export declare function checkInterior(reader: MapReader, resolver: CollisionResolver, input: Inspection, floorCapture?: (floor: {
    id: string;
    cutY: number;
}, bounds: Bounds) => Promise<any>, options?: {
    signal?: AbortSignal;
}): Promise<any>;
