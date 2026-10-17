import { type Args } from './contracts.js';
/** Read ZIP entries in place; never extract user resource packs to the filesystem. */
export declare class AssetArchive {
    readonly file: string;
    private entries;
    private directory;
    private constructor();
    static open(file: string): Promise<AssetArchive>;
    read(name: string): Promise<Buffer | undefined>;
}
export declare function matchesWhen(condition: any, properties: Record<string, string>, version?: string): boolean;
export interface BakedFace {
    positions: number[];
    uv: number[];
    texture: string;
    tint?: number;
}
export interface TextureAnimation {
    frameWidth: number;
    frameHeight: number;
    columns: number;
    frames: {
        index: number;
        durationMs: number;
    }[];
    totalDurationMs: number;
    interpolate: boolean;
    tickMs: number;
}
/** Normalize Java .mcmeta timings. Frame-size defaults follow the 26.3 client codec. */
export declare function normalizeTextureAnimation(metadata: any, imageWidth: number, imageHeight: number): TextureAnimation;
/** Standalone pure function also injected into the browser, so tests exercise its exact clock. */
export declare function textureFrameAt(animation: TextureAnimation, elapsedMs: number): {
    index: number;
    nextIndex: number;
    progress: number;
};
export declare function weightedVariantIndex(variants: any[], position: {
    x: number;
    y: number;
    z: number;
}, salt?: string): number;
export declare function bakeModel(model: any, variant: any, textureId: (value: string) => string): BakedFace[];
export declare class ResourceManager {
    private stateDir;
    private banks;
    constructor(stateDir: string);
    private baseJar;
    private bank;
    private read;
    private json;
    private model;
    prepare(data: any, args?: Args): Promise<{
        models: Record<string, BakedFace[]>;
        modelAssignments: Record<string, string>;
        textures: Record<string, any>;
        source: string;
        approximate: boolean;
        resourcePacks: string[];
        warnings: string[];
        fidelity: {
            renderer: string;
            exactGamePixels: boolean;
            textureAnimations: string;
            weightedModels: string;
            weightedParts: number;
            fluids: string;
        };
        limitations: string[];
    }>;
}
