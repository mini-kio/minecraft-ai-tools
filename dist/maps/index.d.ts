import { type Args, type Service, type ServiceOptions } from '../contracts.js';
export declare class MapService implements Service {
    private options;
    private sessions;
    constructor(options: ServiceOptions);
    private session;
    private describe;
    private selectedBounds;
    private blocks;
    call(action: string, args: Args): Promise<any>;
    close(): Promise<void>;
}
