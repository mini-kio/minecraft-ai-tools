import { Args, Service, ServiceOptions } from '../contracts.js';
export interface PlayerDependencies {
    mineflayer?: any;
    pathfinder?: any;
    vec3?: any;
    playwright?: any;
}
export declare function requireExactVersion(version: string, supported: readonly string[]): void;
export declare function instrumentViewerBundle(bundle: string): string;
export declare function boundedMs(value: unknown, fallback?: number, max?: number): number;
export declare function abortPlayerOperation(signal?: AbortSignal): void;
export declare function withDeadline<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T>;
export declare class PlayerService implements Service {
    private options;
    private dependencies;
    private sessions;
    private shutdown;
    private operations;
    constructor(options: ServiceOptions, dependencies?: PlayerDependencies);
    private libs;
    private get;
    private connected;
    private metadata;
    private observe;
    private release;
    private disconnect;
    private protocolOperation;
    call(action: string, args?: Args): Promise<any>;
    private dispatch;
    private connect;
    private move;
    private createViewer;
    private capture;
    close(): Promise<void>;
}
