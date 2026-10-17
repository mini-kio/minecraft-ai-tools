import { id, fail } from './contracts.js';
export class JobManager {
  jobs = new Map<string, any>();
  start(work: () => Promise<any>, cancel?: () => Promise<any>) {
    const job = { id: id('job'), state: 'running', createdAt: new Date().toISOString(), result: undefined as any, error: undefined as any, cancel, cancellationRequested:false, settled:undefined as Promise<void>|undefined };
    this.jobs.set(job.id, job);
    job.settled=work().then(result => { if (['running','cancelling'].includes(job.state)) { job.state = 'succeeded'; job.result = result; } }, error => { if (['running','cancelling'].includes(job.state)) { job.state = job.cancellationRequested&&error.code==='CANCELLED'?'cancelled':'failed'; job.error = { code: error.code || 'INTERNAL_ERROR', message: error.message }; } }).finally(() => Object.assign(job, { completedAt: new Date().toISOString() }));
    return this.view(job);
  }
  view(job: any) { const { cancel,settled, ...visible } = job; return {...visible,cancellable:!!cancel}; }
  async call(action: string, args: any) {
    if (action === 'list') return [...this.jobs.values()].map(j => this.view(j));
    const job = this.jobs.get(args.job || args.session); if (!job) fail('JOB_NOT_FOUND', 'Job not found');
    if (action === 'cancel' && job.state === 'running') {
      if (!job.cancel) fail('NOT_CANCELLABLE', 'This operation cannot be interrupted safely');
      job.cancellationRequested=true;job.state='cancelling';
      try{await job.cancel();}catch(error:any){job.state='failed';job.error={code:error.code||'CANCELLATION_CLEANUP_FAILED',message:error.message};throw error;}
      let timer:NodeJS.Timeout|undefined;try{await Promise.race([job.settled,new Promise<void>(resolve=>{timer=setTimeout(resolve,Math.min(5000,Math.max(0,Number(args.waitMs??2000))));})]);}finally{if(timer)clearTimeout(timer);}
    }
    return this.view(job);
  }
  async close(){const active=[...this.jobs.values()].filter(job=>['running','cancelling'].includes(job.state));await Promise.allSettled(active.filter(job=>job.state==='running'&&job.cancel).map(job=>this.call('cancel',{job:job.id,waitMs:0})));await Promise.allSettled(active.map(job=>job.settled));}
}
