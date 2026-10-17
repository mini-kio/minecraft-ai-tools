import type { Bounds, Point, MapEntity, MapBlockEntity } from './types.js';
export type NbtTag = {
    type: string;
    value: any;
};
export declare const tag: (type: string, value: any) => NbtTag;
export declare const nbtList: (type: string, value: any[]) => NbtTag;
export declare function nbtValue(value: any): any;
export declare function nbtItems(value: any): NbtTag[];
export interface SourceEntity {
    id: string;
    position: Point;
    blockPosition?: Point;
    nbt: NbtTag;
    passengers: SourceEntity[];
    sourceUuid?: string;
    importTags?: string[];
}
/** Read the source's coordinate wrapper separately from saved (possibly absolute) entity NBT. */
export declare function parseMapEntities(root: NbtTag, kind: string, origin: Point, maximum?: number): SourceEntity[];
export declare function entityInBounds(entity: SourceEntity, bounds: Bounds): boolean;
export declare function entityView(entity: SourceEntity): MapEntity;
export declare function parseMapBlockEntities(root: NbtTag, kind: string, origin: Point): MapBlockEntity[];
export interface EntityImport {
    roots: SourceEntity[];
    flat: SourceEntity[];
    tag: string;
    excluded: number;
    uuidMap: Record<string, string>;
}
export declare function prepareEntities(source: SourceEntity[], bounds: Bounds, seed: string): EntityImport;
/** Skeletons contain only safe identity/mount metadata; all rich data comes from binary storage. */
export declare function summonSkeleton(entity: SourceEntity): NbtTag;
export declare function importedEntityUuid(entity: SourceEntity): string;
