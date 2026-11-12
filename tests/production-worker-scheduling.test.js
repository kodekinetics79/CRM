import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runWorker,startWorkerRuntime} from '../server/production/worker.js';

const leasedJob=(tenantId,index)=>({tenantId,jobId:randomUUID(),kind:'work.run',idempotencyKey:`work-${index}`,payload:{index},version:2,attempts:1,maxAttempts:5,state:'leased',leaseOwner:'fairness-worker'});

test('worker polling retains its round-robin position so a busy tenant cannot starve the next tenant',async()=>{
 const tenantA=randomUUID(),tenantB=randomUUID(),controller=new AbortController(),handled=[];let sequence=0,tenantBAvailable=true;
 const repository={
  async claim({tenantId}){
   if(tenantId===tenantA)return [leasedJob(tenantA,++sequence)];
   if(tenantId===tenantB&&tenantBAvailable){tenantBAvailable=false;return [leasedJob(tenantB,++sequence)];}
   return [];
  },
  async complete(job){return {...job,state:'completed'};},
  async retry(){throw new Error('unexpected retry');}
 };
 await runWorker({repository,handlers:{'work.run':async job=>{handled.push(job.tenantId);if(job.tenantId===tenantB||handled.length===3)controller.abort();}},signal:controller.signal,concurrency:1,tenantIds:[tenantA,tenantB],pollIntervalMs:1,workerId:'fairness-worker'});
 assert.deepEqual(handled,[tenantA,tenantB]);
});

test('worker runtime derives a heartbeat safely below the configured lease',async()=>{
 let received;
 const runtime=await startWorkerRuntime({config:{processRole:'worker',limits:{jobConcurrency:2,jobLeaseMs:5_000}},repository:{},handlers:{},tenantIds:[],signal:AbortSignal.abort(),run:async options=>{received=options;}});
 await runtime.close();
 assert.equal(received.concurrency,2);
 assert.equal(received.heartbeatIntervalMs,1_666);
 assert.ok(received.heartbeatIntervalMs<5_000);
});

test('worker runtime refuses lease edges that cannot satisfy the production heartbeat contract',async()=>{
 for(const jobLeaseMs of [4_999,300_001,1.5,Number.NaN]){
  let polled=0;
  await assert.rejects(()=>startWorkerRuntime({config:{processRole:'worker',limits:{jobConcurrency:1,jobLeaseMs}},repository:{},handlers:{},tenantIds:[],signal:AbortSignal.abort(),run:async()=>{polled++;}}),/lease/i);
  assert.equal(polled,0);
 }
});

test('bounded worker verification aborts at its deadline and rejects false completion counts',async()=>{
 const module=await import('../scripts/worker-verification.mjs').catch(()=>({}));
 assert.equal(typeof module.runBoundedWorkerVerification,'function');
 const deadlineController=new AbortController();
 await assert.rejects(()=>module.runBoundedWorkerVerification({controller:deadlineController,deadlineMs:10,expectedHandled:2,handled:()=>0,run:signal=>new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))}),/deadline/i);
 assert.equal(deadlineController.signal.aborted,true);
 await assert.rejects(()=>module.runBoundedWorkerVerification({controller:new AbortController(),deadlineMs:100,expectedHandled:2,handled:()=>1,run:async()=>{}}),/exactly 2/i);
 assert.equal(await module.runBoundedWorkerVerification({controller:new AbortController(),deadlineMs:100,expectedHandled:2,handled:()=>2,run:async()=>{}}),2);
});
