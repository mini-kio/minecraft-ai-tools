import { WebSocket } from 'ws';
import { Args, Service, ServiceOptions } from './contracts.js';
type Peer = {
    id: string;
    kind: string;
    name: string;
    version?: string;
    capabilities: string[];
    socket?: WebSocket;
    port?: number;
    token?: string;
    discovery?: string;
};
export declare class BridgeService implements Service {
    private options;
    peers: Map<string, Peer>;
    pending: Map<string, {
        peer: string;
        resolve: (v: any) => void;
        reject: (e: any) => void;
        timer: NodeJS.Timeout;
    }>;
    constructor(options: ServiceOptions);
    register(socket: WebSocket, hello: Args): Peer;
    publicPeer(peer: Peer): {
        id: string;
        kind: string;
        name: string;
        version?: string;
        capabilities: string[];
        port?: number;
        discovery?: string;
    };
    discover(directory?: string): Promise<any[]>;
    attach(discovery: string): Promise<any>;
    private http;
    request(peerId: string, action: string, args?: Args): Promise<any>;
    call(action: string, args: Args): Promise<any>;
    close(): Promise<void>;
}
export {};
