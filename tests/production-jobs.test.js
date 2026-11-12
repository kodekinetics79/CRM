import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createJobRepository} from '../server/production/jobRepository.js';
import {runWorker} from '../server/production/worker.js';

const clone=value=>structuredClone(value);
const row=job=>({
 tenant_id:job.tenantId,job_id:job.jobId,queue:job.queue,kind:job.kind,
 idempotency_key:job.idempotencyKey,payload:clone(job.payload),state:job.state,
 priority:job.priority,available_at:new Date(job.availableAt),lease_owner:job.leaseOwner,
 lease_expires_at:job.leaseExpiresAt?new Date(job.leaseExpiresAt):null,attempts:job.attempts,
 max_attempts:job.maxAttempts,version:job.version,created_at:new Date(job.createdAt),
 updated_at:new Date(job.updatedAt),completed_at:job.completedAt?new Date(job.completedAt):null
});

function memoryPool(){
 const jobs=new Map(),attempts=[],deadLetters=[];let tail=Promise.resolve(),inTransaction=0;
 const key=(tenantId,jobId)=>`${tenantId}:${jobId}`;
 const findIdempotent=(tenantId,idempotencyKey)=>[...jobs.values()].find(job=>job.tenantId===tenantId&&job.idempotencyKey===idempotencyKey);
 const session={async query(sql,values=[]){
  if(sql.includes('/*job:enqueue*/')){
   const [tenantId,jobId,queue,kind,idempotencyKey,payload,availableAt,priority,maxAttempts,now]=values;
   let job=findIdempotent(tenantId,idempotencyKey);
   if(!job){job={tenantId,jobId,queue,kind,idempotencyKey,payload:JSON.parse(payload),state:'ready',priority,availableAt:+new Date(availableAt),leaseOwner:null,leaseExpiresAt:null,attempts:0,maxAttempts,version:1,createdAt:+new Date(now),updatedAt:+new Date(now),completedAt:null};jobs.set(key(tenantId,jobId),job);}
   return {rows:[row(job)],rowCount:1};
  }
  if(sql.includes('/*job:sweep-exhausted*/')){
   const [tenantId,queue,now,reasonCode,limit]=values,instant=+new Date(now),exhausted=[...jobs.values()].filter(job=>job.tenantId===tenantId&&job.queue===queue&&job.state==='leased'&&job.leaseExpiresAt<=instant&&job.attempts>=job.maxAttempts).sort((a,b)=>a.leaseExpiresAt-b.leaseExpiresAt).slice(0,limit);
   for(const job of exhausted){job.state='dead_lettered';job.leaseOwner=null;job.leaseExpiresAt=null;job.updatedAt=instant;job.version++;const attempt=attempts.findLast(item=>item.tenantId===tenantId&&item.jobId===job.jobId&&item.attempt===job.attempts);Object.assign(attempt,{finishedAt:instant,outcome:'dead_lettered',errorCode:reasonCode,errorDetail:'Worker lease expired during the final allowed attempt.'});deadLetters.push({tenantId,jobId:job.jobId,reasonCode,reasonDetail:'Worker lease expired during the final allowed attempt.'});}
   return {rows:exhausted.map(row),rowCount:exhausted.length};
  }
  if(sql.includes('/*job:claim*/')){
   assert.match(sql,/FOR UPDATE SKIP LOCKED/i,'claims must not serialize workers behind locked rows');
   const [tenantId,queue,workerId,now,leaseExpiresAt,limit,kinds]=values,instant=+new Date(now);
   const eligible=[...jobs.values()].filter(job=>job.tenantId===tenantId&&job.queue===queue&&(!kinds||kinds.includes(job.kind))&&job.attempts<job.maxAttempts&&((['ready','retry_wait'].includes(job.state)&&job.availableAt<=instant)||(job.state==='leased'&&job.leaseExpiresAt<=instant))).sort((a,b)=>b.priority-a.priority||a.availableAt-b.availableAt||a.createdAt-b.createdAt).slice(0,limit);
   for(const job of eligible){job.state='leased';job.leaseOwner=workerId;job.leaseExpiresAt=+new Date(leaseExpiresAt);job.attempts++;job.version++;job.updatedAt=instant;attempts.push({tenantId,jobId:job.jobId,attempt:job.attempts,workerId,startedAt:instant});}
   return {rows:eligible.map(row),rowCount:eligible.length};
  }
  if(sql.includes('/*job:heartbeat*/')){
   const [tenantId,jobId,workerId,expectedVersion,now,leaseExpiresAt]=values,job=jobs.get(key(tenantId,jobId)),instant=+new Date(now);
   if(!job||job.state!=='leased'||job.leaseOwner!==workerId||job.version!==expectedVersion||job.leaseExpiresAt<=instant)return {rows:[],rowCount:0};
   job.leaseExpiresAt=+new Date(leaseExpiresAt);job.version++;job.updatedAt=instant;return {rows:[row(job)],rowCount:1};
  }
  if(sql.includes('/*job:complete*/')){
   const [tenantId,jobId,workerId,expectedVersion,now]=values,job=jobs.get(key(tenantId,jobId)),instant=+new Date(now);
   if(!job||job.state!=='leased'||job.leaseOwner!==workerId||job.version!==expectedVersion||job.leaseExpiresAt<=instant)return {rows:[],rowCount:0};
   job.state='completed';job.leaseOwner=null;job.leaseExpiresAt=null;job.completedAt=instant;job.updatedAt=instant;job.version++;const attempt=attempts.findLast(item=>item.tenantId===tenantId&&item.jobId===jobId&&item.attempt===job.attempts);Object.assign(attempt,{finishedAt:instant,outcome:'completed'});return {rows:[row(job)],rowCount:1};
  }
  if(sql.includes('/*job:retry*/')){
   const [tenantId,jobId,workerId,expectedVersion,now,availableAt,errorCode,errorDetail]=values,job=jobs.get(key(tenantId,jobId)),instant=+new Date(now);
   if(!job||job.state!=='leased'||job.leaseOwner!==workerId||job.version!==expectedVersion||job.leaseExpiresAt<=instant)return {rows:[],rowCount:0};
   job.state='retry_wait';job.leaseOwner=null;job.leaseExpiresAt=null;job.availableAt=+new Date(availableAt);job.updatedAt=instant;job.version++;const attempt=attempts.findLast(item=>item.tenantId===tenantId&&item.jobId===jobId&&item.attempt===job.attempts);Object.assign(attempt,{finishedAt:instant,outcome:'retry',errorCode,errorDetail});return {rows:[row(job)],rowCount:1};
  }
  if(sql.includes('/*job:dead-letter*/')){
   const [tenantId,jobId,workerId,expectedVersion,now,reasonCode,reasonDetail]=values,job=jobs.get(key(tenantId,jobId)),instant=+new Date(now);
   if(!job||job.state!=='leased'||job.leaseOwner!==workerId||job.version!==expectedVersion||job.leaseExpiresAt<=instant)return {rows:[],rowCount:0};
   job.state='dead_lettered';job.leaseOwner=null;job.leaseExpiresAt=null;job.updatedAt=instant;job.version++;deadLetters.push({tenantId,jobId,reasonCode,reasonDetail});const attempt=attempts.findLast(item=>item.tenantId===tenantId&&item.jobId===jobId&&item.attempt===job.attempts);Object.assign(attempt,{finishedAt:instant,outcome:'dead_lettered',errorCode:reasonCode,errorDetail:reasonDetail});return {rows:[row(job)],rowCount:1};
  }
  if(sql.includes('/*job:release-unstarted*/')){
   const [tenantId,jobId,workerId,expectedVersion,now]=values,job=jobs.get(key(tenantId,jobId)),instant=+new Date(now);
   if(!job||job.state!=='leased'||job.leaseOwner!==workerId||job.version!==expectedVersion||job.leaseExpiresAt<=instant)return {rows:[],rowCount:0};
   attempts.splice(attempts.findIndex(item=>item.tenantId===tenantId&&item.jobId===jobId&&item.attempt===job.attempts),1);job.state='ready';job.leaseOwner=null;job.leaseExpiresAt=null;job.attempts--;job.updatedAt=instant;job.version++;return {rows:[row(job)],rowCount:1};
  }
  throw new Error(`Unexpected SQL: ${sql}`);
 }};
 const pool={async withTransaction(_tenantId,fn){let release;const previous=tail;tail=new Promise(resolve=>{release=resolve;});await previous;inTransaction++;try{return await fn(session);}finally{inTransaction--;release();}}};
 return {pool,jobs,attempts,deadLetters,get inTransaction(){return inTransaction;}};
}

function clockFixture(start='2026-11-11T12:00:00.000Z'){
 let instant=Date.parse(start);return {clock:()=>new Date(instant),advance:ms=>{instant+=ms;},value:()=>instant};
}

test('enqueue is idempotent per tenant while the same key remains valid in another tenant',async()=>{
 const db=memoryPool(),time=clockFixture(),repository=createJobRepository({tenantPool:db.pool,clock:time.clock});
 const tenantA=randomUUID(),tenantB=randomUUID(),first=await repository.enqueue({tenantId:tenantA,kind:'email.send',idempotencyKey:'welcome-1',payload:{to:'a@example.invalid'}});
 const replay=await repository.enqueue({tenantId:tenantA,kind:'email.send',idempotencyKey:'welcome-1',payload:{to:'changed@example.invalid'}});
 const other=await repository.enqueue({tenantId:tenantB,kind:'email.send',idempotencyKey:'welcome-1',payload:{to:'b@example.invalid'}});
 assert.equal(replay.jobId,first.jobId);assert.deepEqual(replay.payload,{to:'a@example.invalid'});assert.notEqual(other.jobId,first.jobId);assert.equal(db.jobs.size,2);
});

test('scheduled jobs are unavailable until due and concurrent claims never receive the same job',async()=>{
 const db=memoryPool(),time=clockFixture(),repository=createJobRepository({tenantPool:db.pool,clock:time.clock,leaseMs:60_000}),tenantId=randomUUID();
 await repository.enqueue({tenantId,kind:'report.prepare',idempotencyKey:'now-1',payload:{reportId:'one'}});
 await repository.enqueue({tenantId,kind:'report.prepare',idempotencyKey:'now-2',payload:{reportId:'two'}});
 await repository.enqueue({tenantId,kind:'report.prepare',idempotencyKey:'later',payload:{reportId:'later'},availableAt:new Date(time.value()+10_000)});
 const [a,b]=await Promise.all([repository.claim({tenantId,workerId:'worker-a',limit:1}),repository.claim({tenantId,workerId:'worker-b',limit:1})]);
 assert.equal(a.length,1);assert.equal(b.length,1);assert.notEqual(a[0].jobId,b[0].jobId);assert.deepEqual(await repository.claim({tenantId,workerId:'worker-c',limit:1}),[]);
 time.advance(10_000);assert.equal((await repository.claim({tenantId,workerId:'worker-c',limit:1}))[0].idempotencyKey,'later');
});

test('retry uses bounded exponential delay and exhausts into dead letter state',async()=>{
 const db=memoryPool(),time=clockFixture(),repository=createJobRepository({tenantPool:db.pool,clock:time.clock,leaseMs:60_000,retryBaseMs:1_000,retryMaxMs:2_000}),tenantId=randomUUID();
 await repository.enqueue({tenantId,kind:'provider.sync',idempotencyKey:'sync-1',payload:{cursor:1},maxAttempts:3});
 let [job]=await repository.claim({tenantId,workerId:'worker-a'});job=await repository.retry({...job,workerId:'worker-a',errorCode:'UPSTREAM',errorDetail:'first'});assert.equal(+job.availableAt,time.value()+1_000);
 time.advance(1_000);[job]=await repository.claim({tenantId,workerId:'worker-a'});job=await repository.retry({...job,workerId:'worker-a',errorCode:'UPSTREAM',errorDetail:'second'});assert.equal(+job.availableAt,time.value()+2_000);
 time.advance(2_000);[job]=await repository.claim({tenantId,workerId:'worker-a'});job=await repository.retry({...job,workerId:'worker-a',errorCode:'UPSTREAM',errorDetail:'third'});
 assert.equal(job.state,'dead_lettered');assert.equal(db.deadLetters.length,1);assert.equal(db.attempts.length,3);
 const metrics=repository.getMetrics();assert.equal(metrics.deadLetters,1);assert.equal(metrics.attempts,3);assert.equal(Object.hasOwn(metrics,'payload'),false);assert.doesNotMatch(JSON.stringify(metrics),/cursor|UPSTREAM/);
});

test('a crash on the final leased attempt is swept into dead letter state',async()=>{
 const db=memoryPool(),time=clockFixture(),repository=createJobRepository({tenantPool:db.pool,clock:time.clock,leaseMs:1_000}),tenantId=randomUUID();
 const queued=await repository.enqueue({tenantId,kind:'provider.final',idempotencyKey:'final-crash',payload:{},maxAttempts:1});
 const [lease]=await repository.claim({tenantId,workerId:'worker-a'});assert.equal(lease.attempts,1);
 time.advance(1_001);assert.deepEqual(await repository.claim({tenantId,workerId:'worker-b'}),[]);
 const retained=db.jobs.get(`${tenantId}:${queued.jobId}`);assert.equal(retained.state,'dead_lettered');assert.equal(retained.leaseOwner,null);assert.equal(db.deadLetters.length,1);assert.equal(db.attempts[0].outcome,'dead_lettered');assert.equal(repository.getMetrics().deadLetters,1);
 assert.deepEqual(await repository.claim({tenantId,workerId:'worker-c'}),[]);assert.equal(db.deadLetters.length,1);
});

test('heartbeat and completion require the current unexpired lease owner and version',async()=>{
 const db=memoryPool(),time=clockFixture(),repository=createJobRepository({tenantPool:db.pool,clock:time.clock,leaseMs:5_000}),tenantId=randomUUID();
 await repository.enqueue({tenantId,kind:'export.create',idempotencyKey:'export-1',payload:{format:'csv'}});let [job]=await repository.claim({tenantId,workerId:'worker-a'});
 await assert.rejects(()=>repository.heartbeat({...job,workerId:'worker-b'}),error=>error.code==='PERSISTENCE_CONFLICT');
 job=await repository.heartbeat({...job,workerId:'worker-a'});await assert.rejects(()=>repository.complete({...job,workerId:'worker-b'}),error=>error.code==='PERSISTENCE_CONFLICT');
 const completed=await repository.complete({...job,workerId:'worker-a'});assert.equal(completed.state,'completed');
});

test('claims can be restricted to registered handler kinds without consuming unknown jobs',async()=>{
 const db=memoryPool(),time=clockFixture(),repository=createJobRepository({tenantPool:db.pool,clock:time.clock}),tenantId=randomUUID();
 await repository.enqueue({tenantId,kind:'unknown.job',idempotencyKey:'unknown-1',payload:{}});await repository.enqueue({tenantId,kind:'known.job',idempotencyKey:'known-1',payload:{}});
 const [known]=await repository.claim({tenantId,workerId:'worker-a',kinds:['known.job']});assert.equal(known.kind,'known.job');
 assert.equal((await repository.claim({tenantId,workerId:'worker-b',kinds:['known.job']})).length,0);assert.equal((await repository.claim({tenantId,workerId:'worker-b'}))[0].kind,'unknown.job');
});

test('an expired lease is reclaimed while one idempotent effect and one completion win',async()=>{
 const db=memoryPool(),time=clockFixture(),repository=createJobRepository({tenantPool:db.pool,clock:time.clock,leaseMs:1_000}),tenantId=randomUUID(),effects=new Map();
 await repository.enqueue({tenantId,kind:'payment.capture',idempotencyKey:'capture-42',payload:{amount:4200}});const [leaseA]=await repository.claim({tenantId,workerId:'worker-a'});
 const handle=job=>{if(!effects.has(job.idempotencyKey))effects.set(job.idempotencyKey,{providerId:'provider-1'});return effects.get(job.idempotencyKey);};
 handle(leaseA);time.advance(1_001);const [leaseB]=await repository.claim({tenantId,workerId:'worker-b'});handle(leaseB);
 const won=await repository.complete({...leaseB,workerId:'worker-b'});assert.equal(won.state,'completed');await assert.rejects(()=>repository.complete({...leaseA,workerId:'worker-a'}),error=>error.code==='PERSISTENCE_CONFLICT');assert.equal(effects.size,1);
});

test('the worker bounds global and per-tenant concurrency and never runs a handler inside a repository transaction',async()=>{
 const tenantA=randomUUID(),tenantB=randomUUID(),jobs=[1,2,3,4].map((n,index)=>({tenantId:index<2?tenantA:tenantB,jobId:randomUUID(),kind:'work.run',idempotencyKey:`work-${n}`,payload:{n},version:2,attempts:1,state:'leased'}));
 let active=0,peak=0,transactionActive=0;const perTenant=new Map(),tenantPeak=new Map(),completed=[];const controller=new AbortController();
 const repository={
  async claim({workerId,tenantId,kinds}){assert.deepEqual(kinds,['work.run']);transactionActive++;try{const index=jobs.findIndex(job=>job.tenantId===tenantId&&kinds.includes(job.kind));if(index<0)return [];const [job]=jobs.splice(index,1);return [{...job,leaseOwner:workerId}];}finally{transactionActive--; }},
  async complete(job){completed.push(job.jobId);if(completed.length===4)controller.abort();return {...job,state:'completed'};},
  async retry(job){throw new Error(`unexpected retry ${job.jobId}`);}
 };
 await runWorker({repository,handlers:{'work.run':async job=>{assert.equal(transactionActive,0);assert.equal(typeof job.idempotencyKey,'string');active++;peak=Math.max(peak,active);const count=(perTenant.get(job.tenantId)||0)+1;perTenant.set(job.tenantId,count);tenantPeak.set(job.tenantId,Math.max(tenantPeak.get(job.tenantId)||0,count));await new Promise(resolve=>setTimeout(resolve,5));perTenant.set(job.tenantId,count-1);active--;}},signal:controller.signal,concurrency:2,tenantIds:[tenantA,tenantB]});
 assert.equal(completed.length,4);assert.equal(peak,2);assert.deepEqual([...tenantPeak.values()],[1,1]);
});

test('abort stops new claims and waits for in-flight work to settle',async()=>{
 const controller=new AbortController(),tenantId=randomUUID(),job={tenantId,jobId:randomUUID(),kind:'slow',idempotencyKey:'slow-1',payload:{},version:2,attempts:1,state:'leased',leaseOwner:'worker'};let claims=0,completed=false,release;
 const repository={async claim(){claims++;return claims===1?[job]:[];},async complete(){completed=true;return {...job,state:'completed'};},async retry(){throw new Error('unexpected retry');}};
 const running=runWorker({repository,handlers:{slow:async()=>new Promise(resolve=>{release=resolve;})},signal:controller.signal,concurrency:1,tenantIds:[tenantId]});
 while(!release)await new Promise(resolve=>setImmediate(resolve));controller.abort();release();await running;assert.equal(completed,true);assert.equal(claims,1);
});

test('long-running handlers heartbeat and complete with the latest lease version',{timeout:5_000},async()=>{
 const controller=new AbortController(),tenantId=randomUUID();let version=2,heartbeats=0,claims=0,completedVersion=0,releaseAfterTwo;const twoHeartbeats=new Promise(resolve=>{releaseAfterTwo=resolve;});
 const job={tenantId,jobId:randomUUID(),kind:'long',idempotencyKey:'long-1',payload:{},version,attempts:1,maxAttempts:5,state:'leased',leaseOwner:'worker'};
 const repository={
  async claim(){claims++;return claims===1?[{...job}]:[];},
  async heartbeat(current){heartbeats++;version++;if(heartbeats===2)releaseAfterTwo();return {...current,version};},
  async complete(current){completedVersion=current.version;controller.abort();return {...current,state:'completed'};},
  async retry(){throw new Error('unexpected retry');}
 };
 await runWorker({repository,handlers:{long:async()=>twoHeartbeats},signal:controller.signal,concurrency:1,tenantIds:[tenantId],heartbeatIntervalMs:5});
 assert.ok(heartbeats>=2);assert.equal(completedVersion,version);
});

test('abort racing a claim releases the lease without invoking its handler',async()=>{
 const controller=new AbortController(),tenantId=randomUUID(),job={tenantId,jobId:randomUUID(),kind:'provider.call',idempotencyKey:'race-1',payload:{},version:2,attempts:1,maxAttempts:5,state:'leased',leaseOwner:'worker'};let resolveClaim,handled=0,released;
 const repository={
  claim:()=>new Promise(resolve=>{resolveClaim=resolve;}),
  async complete(){throw new Error('unexpected completion');},
  async retry(){throw new Error('unexpected retry');},
  async release(current){released=current;return {...current,state:'ready'};}
 };
 const running=runWorker({repository,handlers:{'provider.call':async()=>{handled++;}},signal:controller.signal,concurrency:1,tenantIds:[tenantId]});
 while(!resolveClaim)await new Promise(resolve=>setImmediate(resolve));controller.abort();resolveClaim([job]);await running;
 assert.equal(handled,0);assert.equal(released.jobId,job.jobId);
});

test('a polling failure drains already active handlers before the worker rejects',async()=>{
 const tenantA=randomUUID(),tenantB=randomUUID(),job={tenantId:tenantA,jobId:randomUUID(),kind:'slow',idempotencyKey:'slow-poll-failure',payload:{},version:2,attempts:1,maxAttempts:5,state:'leased',leaseOwner:'worker'};let release,started=false,finished=false,settled=false;
 const repository={async claim({tenantId}){if(tenantId===tenantA)return [job];throw new Error('poll failed');},async complete(){return {...job,state:'completed'};},async retry(){throw new Error('unexpected retry');}};
 const running=runWorker({repository,handlers:{slow:async()=>{started=true;await new Promise(resolve=>{release=resolve;});finished=true;}},signal:new AbortController().signal,concurrency:2,tenantIds:[tenantA,tenantB]}).then(()=>({error:null}),error=>({error})).finally(()=>{settled=true;});
 while(!started)await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
 release();const outcome=await running;assert.match(outcome.error?.message??'',/poll failed/);assert.equal(finished,true);
});

test('shutdown after a final-attempt claim releases it without dead-lettering unstarted work',async()=>{
 const db=memoryPool(),time=clockFixture(),repository=createJobRepository({tenantPool:db.pool,clock:time.clock,leaseMs:60_000}),tenantId=randomUUID(),controller=new AbortController();let handled=0;
 const queued=await repository.enqueue({tenantId,kind:'provider.call',idempotencyKey:'shutdown-before-dispatch',payload:{},maxAttempts:1});
 const workerRepository={...repository,async claim(input){const claimed=await repository.claim(input);controller.abort();return claimed;}};
 await runWorker({repository:workerRepository,handlers:{'provider.call':async()=>{handled++;}},signal:controller.signal,concurrency:1,tenantIds:[tenantId]});
 const retained=db.jobs.get(`${tenantId}:${queued.jobId}`);assert.equal(handled,0);assert.equal(retained.state,'ready');assert.equal(retained.attempts,0);assert.equal(db.deadLetters.length,0);
 assert.equal((await repository.claim({tenantId,workerId:'next-worker'}))[0].jobId,queued.jobId);
});

test('a worker with no registered handlers refuses startup before claiming',async()=>{
 let claims=0;await assert.rejects(()=>runWorker({repository:{claim:async()=>{claims++;return [];},complete:async()=>{},retry:async()=>{}},handlers:{},signal:AbortSignal.abort(),concurrency:1,tenantIds:[]}),/registered job handler/i);assert.equal(claims,0);
});
