import { spawn } from 'node:child_process';
import { Args, Service, ServiceOptions } from '../contracts.js';
export declare const MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
export interface VersionEntry {
    id: string;
    type: string;
    url: string;
    sha1: string;
    releaseTime: string;
}
export interface JavaRuntime {
    path: string;
    major: number;
    version: string;
}
export interface ServerDependencies {
    fetch?: typeof fetch;
    spawn?: typeof spawn;
    discoverJava?: (path?: string, signal?: AbortSignal) => Promise<JavaRuntime[]>;
    rconConnect?: (options: any) => Promise<any>;
}
export declare function officialUrl(value: string): URL;
export declare function verifyHash(bytes: Uint8Array, expected: string, algorithm?: 'sha1' | 'sha256'): string;
export declare function parseJavaVersion(text: string): {
    major: number;
    version: string;
} | null;
export declare function releaseTargets(entries: VersionEntry[]): VersionEntry[];
export declare function abortServerOperation(signal?: AbortSignal): void;
export declare function discoverJava(explicit?: string, signal?: AbortSignal): Promise<JavaRuntime[]>;
export declare function assertSafeWorld(source: string, destination: string, signal?: AbortSignal): Promise<string>;
/** Copy only into a caller-owned fresh directory, with cancellation between files and stream chunks. */
export declare function copyWorld(source: string, destination: string, signal?: AbortSignal, progress?: (phase: string) => void): Promise<void>;
export declare class ServerService implements Service {
    private options;
    private dependencies;
    private servers;
    private initialization?;
    private saving;
    private shutdown;
    private operations;
    private fetcher;
    constructor(options: ServiceOptions, dependencies?: ServerDependencies);
    private root;
    private metadata;
    private init;
    private save;
    private get;
    private request;
    private responseBytes;
    private responseJson;
    private downloadFile;
    private manifest;
    call(action: string, args?: Args): Promise<any>;
    private dispatch;
    private freePort;
    private create;
    private removeOwnedDirectory;
    private addLog;
    private start;
    private stop;
    private stopOwned;
    close(): Promise<void>;
}
