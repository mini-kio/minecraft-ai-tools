export type Args = Record<string, any>;
export interface Service {
    call(action: string, args: Args): Promise<any>;
    close(): Promise<void>;
}
export interface ServiceOptions {
    artifactDir: string;
    stateDir: string;
}
export declare class ToolError extends Error {
    code: string;
    details?: unknown | undefined;
    constructor(code: string, message: string, details?: unknown | undefined);
}
export declare function fail(code: string, message: string, details?: unknown): never;
export declare function id(prefix: string): string;
export declare function required<T>(value: T | undefined | null, name: string): T;
export declare function finite(value: unknown, name: string): number;
