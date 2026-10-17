/** XXH32 used by the lz4-java block stream (Minecraft's region type 4). */
export declare function xxhash32(input: Buffer, seed?: number): number;
/** Bounded lz4-java LZ4BlockInputStream framing, including its masked XXH32 checksum. */
export declare function decodeAnvilLz4(input: Buffer, maxOutput?: number): Buffer;
