export interface SourceFile {
    path: string;
    sha256?: string;
    bytes?: number;
    modifiedAt?: string;
    error?: string;
}
export interface ModelSource {
    sourceText: string;
    files: SourceFile[];
    warnings: string[];
}
export declare function fingerprint(file: string): Promise<SourceFile>;
export declare function readModelSource(file: string, assetRoot?: string): Promise<ModelSource>;
