import { Args } from './contracts.js';
import { BridgeService } from './bridges.js';
export declare class NativeNavigation {
    private bridges;
    private artifactDir;
    private active;
    private scanning;
    constructor(bridges: BridgeService, artifactDir: string);
    cancel(client: string): void;
    move(client: string, args: Args): Promise<any>;
    follow(client: string, path: Array<{
        x: number;
        y: number;
        z: number;
    }>, args?: Args): Promise<any>;
    close(): void;
}
