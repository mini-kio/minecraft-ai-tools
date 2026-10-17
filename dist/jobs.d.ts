export declare class JobManager {
    jobs: Map<string, any>;
    start(work: () => Promise<any>, cancel?: () => Promise<any>): any;
    view(job: any): any;
    call(action: string, args: any): Promise<any>;
    close(): Promise<void>;
}
