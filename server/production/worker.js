import {randomUUID} from 'node:crypto';

const sleep=(ms,signal)=>signal?.aborted?Promise.resolve():new Promise(resolve=>{const timer=setTimeout(done,ms);timer.unref?.();signal?.addEventListener('abort',done,{once:true});function done(){clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();}});
const tenants=async source=>{const value=typeof source==='function'?await source():source;if(!value||typeof value[Symbol.iterator]!=='function')throw new TypeError('Worker tenantIds must be an iterable or a function returning one.');return [...new Set(value)];};
const handlerFor=(handlers,kind)=>handlers instanceof Map?handlers.get(kind):handlers?.[kind];
const failure=error=>({errorCode:String(error?.code||'HANDLER_FAILED').slice(0,120),errorDetail:String(error?.message||'Job handler failed.').slice(0,2_000)});

export async function runWorker({repository,handlers,signal,concurrency=4,tenantIds,pollIntervalMs=50,heartbeatIntervalMs=10_000,workerId=`worker-${randomUUID()}`}={}){
 if(!repository||typeof repository.claim!=='function'||typeof repository.complete!=='function'||typeof repository.retry!=='function')throw new TypeError('A durable job repository is required.');
 if(!signal||typeof signal.addEventListener!=='function')throw new TypeError('An AbortSignal is required.');
 if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>100)throw new TypeError('Worker concurrency must be between 1 and 100.');
 if(!Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<1||pollIntervalMs>60_000)throw new TypeError('Worker poll interval must be between 1 and 60000 milliseconds.');
 if(!Number.isSafeInteger(heartbeatIntervalMs)||heartbeatIntervalMs<1||heartbeatIntervalMs>60_000)throw new TypeError('Worker heartbeat interval must be between 1 and 60000 milliseconds.');
 const active=new Set(),activeTenants=new Set();

 const processJob=async job=>{
  let owned=job,stopped=false,leaseLost=false,heartbeatChain=Promise.resolve();const leaseSignal=new AbortController();
  const beat=()=>{heartbeatChain=heartbeatChain.then(async()=>{if(stopped||typeof repository.heartbeat!=='function')return;owned=await repository.heartbeat({...owned,workerId:owned.leaseOwner||workerId});}).catch(()=>{leaseLost=true;leaseSignal.abort();});};
  const timer=typeof repository.heartbeat==='function'?setInterval(beat,heartbeatIntervalMs):null;timer?.unref?.();
  const stopHeartbeat=async()=>{if(stopped)return;stopped=true;if(timer)clearInterval(timer);await heartbeatChain;};
  try{
   const handler=handlerFor(handlers,job.kind);if(typeof handler!=='function'){const error=new Error(`No handler is registered for job kind ${job.kind}.`);error.code='HANDLER_NOT_REGISTERED';throw error;}
   await handler({...job,signal:leaseSignal.signal});
   await stopHeartbeat();if(leaseLost)return;
   await repository.complete({...owned,workerId:owned.leaseOwner||workerId});
  }catch(error){
   await stopHeartbeat();if(leaseLost)return;
   await repository.retry({...owned,workerId:owned.leaseOwner||workerId,...failure(error)});
  }
 };
 const launch=job=>{
  activeTenants.add(job.tenantId);
  const work=processJob(job).catch(()=>{}).finally(()=>{active.delete(work);activeTenants.delete(job.tenantId);});
  active.add(work);
 };

 while(!signal.aborted){
  let claimed=false;
  for(const tenantId of await tenants(tenantIds)){
   if(signal.aborted||active.size>=concurrency)break;
   if(activeTenants.has(tenantId))continue;
   const [job]=await repository.claim({tenantId,workerId,limit:1});
   if(job){
    claimed=true;
    if(signal.aborted){await repository.retry({...job,workerId:job.leaseOwner||workerId,errorCode:'WORKER_SHUTDOWN',errorDetail:'Worker stopped after claim and before handler dispatch.'}).catch(()=>{});break;}
    launch(job);
   }
  }
  if(signal.aborted)break;
  if(!claimed||active.size>=concurrency)await (active.size?Promise.race([...active,sleep(pollIntervalMs,signal)]):sleep(pollIntervalMs,signal));
 }
 await Promise.allSettled([...active]);
}
