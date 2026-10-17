import { Args, Service } from './contracts.js';
import { BridgeService } from './bridges.js';
export declare class ModelService implements Service {
    private bridges;
    sessions: Map<string, any>;
    private controllers;
    private sources;
    private watchers;
    constructor(bridges: BridgeService);
    private watchSource;
    private sourceStatus;
    call(action: string, args: Args): Promise<any>;
    close(): Promise<void>;
}
