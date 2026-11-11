import {randomUUID} from 'node:crypto';
import {PERSISTENCE_CODES,assertTenantId,persistenceFail} from '../persistence/contract.js';

const QUEUE=/^[a-z][a-z0-9_-]{0,63}$/;
const KIND=/^[a-z][a-z0-9_.:-]{0,127}$/;
const WORKER=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const bounded=(value,label,max)=>{const text=String(value??'').trim();if(!text||text.length>max)persistenceFail(PERSISTENCE_CODES.INVALID,`${label} must contain between 1 and ${max} characters.`);return text;};
const positive=(value,label,max)=>{if(!Number.isSafeInteger(value)||value<1||value>max)persistenceFail(PERSISTENCE_CODES.INVALID,`${label} must be an integer between 1 and ${max}.`);return value;};
const instant=(value,label)=>{const date=value instanceof Date?new Date(value):new Date(value);if(Number.isNaN(date.getTime()))persistenceFail(PERSISTENCE_CODES.INVALID,`${label} must be a valid timestamp.`);return date;};
const jobId=value=>{const id=value??randomUUID();if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))persistenceFail(PERSISTENCE_CODES.INVALID,'Job identity must be a UUID.');return id.toLowerCase();};
const queueName=value=>{const queue=value??'default';if(!QUEUE.test(queue))persistenceFail(PERSISTENCE_CODES.INVALID,'Job queue is invalid.');return queue;};
const kindName=value=>{if(typeof value!=='string'||!KIND.test(value))persistenceFail(PERSISTENCE_CODES.INVALID,'Job kind is invalid.');return value;};
const workerName=value=>{if(typeof value!=='string'||!WORKER.test(value))persistenceFail(PERSISTENCE_CODES.INVALID,'Worker identity is invalid.');return value;};
const json=value=>{let text;try{text=JSON.stringify(value);}catch{persistenceFail(PERSISTENCE_CODES.INVALID,'Job payload must be JSON serializable.');}if(text===undefined||Buffer.byteLength(text)>262_144)persistenceFail(PERSISTENCE_CODES.INVALID,'Job payload must be JSON and no larger than 256 KiB.');return text;};

const mapJob=row=>row?{
 tenantId:row.tenant_id,jobId:row.job_id,queue:row.queue,kind:row.kind,
 idempotencyKey:row.idempotency_key,payload:row.payload,state:row.state,
 priority:Number(row.priority),availableAt:new Date(row.available_at),leaseOwner:row.lease_owner,
 leaseExpiresAt:row.lease_expires_at?new Date(row.lease_expires_at):null,
 attempts:Number(row.attempts),maxAttempts:Number(row.max_attempts),version:Number(row.version),
 createdAt:new Date(row.created_at),updatedAt:new Date(row.updated_at),completedAt:row.completed_at?new Date(row.completed_at):null
}:null;

export function createJobRepository({tenantPool,clock=()=>new Date(),leaseMs=30_000,retryBaseMs=1_000,retryMaxMs=300_000}={}){
 if(!tenantPool||typeof tenantPool.withTransaction!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,'A tenant PostgreSQL pool is required.');
 positive(leaseMs,'Job lease duration',86_400_000);positive(retryBaseMs,'Retry base delay',86_400_000);positive(retryMaxMs,'Retry maximum delay',86_400_000);
 if(retryBaseMs>retryMaxMs)persistenceFail(PERSISTENCE_CODES.INVALID,'Retry base delay cannot exceed the retry maximum.');
 const metrics={claims:0,attempts:0,retries:0,deadLetters:0,completed:0,heartbeats:0,queueLagMs:0};
 const now=()=>instant(clock(),'Clock value');
 const conflict=action=>persistenceFail(PERSISTENCE_CODES.CONFLICT,`Job ${action} was refused because the lease is stale, expired or owned by another worker.`);

 function normalizeEnqueue({tenantId,jobId:id,queue='default',kind,idempotencyKey,payload,availableAt=now(),priority=0,maxAttempts=5}){
  const tenant=assertTenantId(tenantId),identity=jobId(id),queueValue=queueName(queue),kindValue=kindName(kind),key=bounded(idempotencyKey,'Idempotency key',200),body=json(payload),due=instant(availableAt,'Job availability'),created=now();
  if(!Number.isSafeInteger(priority)||priority< -100||priority>100)persistenceFail(PERSISTENCE_CODES.INVALID,'Job priority must be between -100 and 100.');
  positive(maxAttempts,'Job maximum attempts',25);
  return {tenant,identity,queueValue,kindValue,key,body,due,priority,maxAttempts,created};
 }

 async function enqueueInTransaction(session,input){
  if(!session||typeof session.query!=='function')persistenceFail(PERSISTENCE_CODES.INVALID,'A transaction session is required to enqueue a job.');
  const normalized=normalizeEnqueue(input);
  const {tenant,identity,queueValue,kindValue,key,body,due,priority,maxAttempts,created}=normalized;
  const {rows}=await session.query(`/*job:enqueue*/
    INSERT INTO wimblo_platform.durable_jobs(tenant_id,job_id,queue,kind,idempotency_key,payload,available_at,priority,max_attempts,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$10)
    ON CONFLICT (tenant_id,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key
    RETURNING *`,[tenant,identity,queueValue,kindValue,key,body,due,priority,maxAttempts,created]);
  return mapJob(rows[0]);
 }

 async function enqueue(input){
  const tenant=assertTenantId(input?.tenantId);
  return tenantPool.withTransaction(tenant,session=>enqueueInTransaction(session,input));
 }

 async function claim({tenantId,queue='default',workerId,limit=1,kinds=null}){
  const tenant=assertTenantId(tenantId),queueValue=queueName(queue),worker=workerName(workerId),count=positive(limit,'Claim limit',100),claimedAt=now(),expiresAt=new Date(claimedAt.getTime()+leaseMs);
  const allowedKinds=kinds===null?null:[...new Set(kinds)].map(kindName);if(allowedKinds&&allowedKinds.length===0)persistenceFail(PERSISTENCE_CODES.INVALID,'A kind-restricted claim requires at least one job kind.');
  const claimed=await tenantPool.withTransaction(tenant,async session=>{
   const exhausted=await session.query(`/*job:sweep-exhausted*/
    WITH candidates AS (
      SELECT tenant_id,job_id,attempts FROM wimblo_platform.durable_jobs
      WHERE tenant_id=$1 AND queue=$2 AND state='leased' AND lease_expires_at <= $3 AND attempts >= max_attempts
      ORDER BY lease_expires_at,job_id FOR UPDATE SKIP LOCKED LIMIT $5
    ), finished AS (
      UPDATE wimblo_platform.durable_job_attempts a SET finished_at=$3,outcome='dead_lettered',error_code=$4,error_detail='Worker lease expired during the final allowed attempt.'
      FROM candidates c WHERE a.tenant_id=c.tenant_id AND a.job_id=c.job_id AND a.attempt=c.attempts AND a.finished_at IS NULL
      RETURNING a.tenant_id,a.job_id
    ), moved AS (
      UPDATE wimblo_platform.durable_jobs j SET state='dead_lettered',lease_owner=NULL,lease_expires_at=NULL,updated_at=$3,version=j.version+1
      FROM candidates c WHERE j.tenant_id=c.tenant_id AND j.job_id=c.job_id AND EXISTS (SELECT 1 FROM finished f WHERE f.tenant_id=c.tenant_id AND f.job_id=c.job_id)
      RETURNING j.*
    ), recorded AS (
      INSERT INTO wimblo_platform.dead_letter_jobs(tenant_id,job_id,dead_lettered_at,reason_code,reason_detail)
      SELECT tenant_id,job_id,$3,$4,'Worker lease expired during the final allowed attempt.' FROM moved
      ON CONFLICT (tenant_id,job_id) DO NOTHING RETURNING tenant_id,job_id
    ) SELECT moved.* FROM moved JOIN recorded USING(tenant_id,job_id)`,[tenant,queueValue,claimedAt,'LEASE_EXPIRED_FINAL_ATTEMPT',count]);
   const {rows}=await session.query(`/*job:claim*/
    WITH candidates AS (
      SELECT tenant_id,job_id,state,attempts FROM wimblo_platform.durable_jobs
      WHERE tenant_id=$1 AND queue=$2 AND ($7::text[] IS NULL OR kind=ANY($7::text[])) AND attempts < max_attempts
        AND ((state IN ('ready','retry_wait') AND available_at <= $4) OR (state='leased' AND lease_expires_at <= $4))
      ORDER BY priority DESC, CASE WHEN state='leased' THEN lease_expires_at ELSE available_at END, created_at, job_id
      FOR UPDATE SKIP LOCKED LIMIT $6
    ), expired AS (
      UPDATE wimblo_platform.durable_job_attempts a SET finished_at=$4,outcome='retry',error_code='LEASE_EXPIRED',error_detail='Worker lease expired before completion.'
      FROM candidates c WHERE c.state='leased' AND a.tenant_id=c.tenant_id AND a.job_id=c.job_id AND a.attempt=c.attempts AND a.finished_at IS NULL
    ), claimed AS (
      UPDATE wimblo_platform.durable_jobs j SET state='leased',lease_owner=$3,lease_expires_at=$5,attempts=j.attempts+1,version=j.version+1,updated_at=$4
      FROM candidates c WHERE j.tenant_id=c.tenant_id AND j.job_id=c.job_id RETURNING j.*
    ), logged AS (
      INSERT INTO wimblo_platform.durable_job_attempts(tenant_id,job_id,attempt,worker_id,started_at)
      SELECT tenant_id,job_id,attempts,$3,$4 FROM claimed RETURNING tenant_id,job_id
    ) SELECT claimed.* FROM claimed JOIN logged USING(tenant_id,job_id)`,[tenant,queueValue,worker,claimedAt,expiresAt,count,allowedKinds]);
   return {jobs:rows.map(mapJob),swept:exhausted.rowCount};
  });
  const jobs=claimed.jobs;metrics.deadLetters+=claimed.swept;
  metrics.claims+=jobs.length;metrics.attempts+=jobs.length;
  for(const job of jobs)metrics.queueLagMs=Math.max(metrics.queueLagMs,Math.max(0,claimedAt-job.availableAt));
  return jobs;
 }

 async function heartbeat({tenantId,jobId:id,workerId,version,expectedVersion=version}){
  const tenant=assertTenantId(tenantId),identity=jobId(id),worker=workerName(workerId),fence=positive(expectedVersion,'Job version',2_147_483_647),beatAt=now(),expiresAt=new Date(beatAt.getTime()+leaseMs);
  const result=await tenantPool.withTransaction(tenant,session=>session.query(`/*job:heartbeat*/
   UPDATE wimblo_platform.durable_jobs SET lease_expires_at=$6,updated_at=$5,version=version+1
   WHERE tenant_id=$1 AND job_id=$2 AND state='leased' AND lease_owner=$3 AND version=$4 AND lease_expires_at>$5 RETURNING *`,[tenant,identity,worker,fence,beatAt,expiresAt]));
  if(!result.rowCount)conflict('heartbeat');metrics.heartbeats++;return mapJob(result.rows[0]);
 }

 async function complete({tenantId,jobId:id,workerId,version,expectedVersion=version}){
  const tenant=assertTenantId(tenantId),identity=jobId(id),worker=workerName(workerId),fence=positive(expectedVersion,'Job version',2_147_483_647),finished=now();
  const result=await tenantPool.withTransaction(tenant,session=>session.query(`/*job:complete*/
   WITH owned AS (
    UPDATE wimblo_platform.durable_jobs SET state='completed',lease_owner=NULL,lease_expires_at=NULL,completed_at=$5,updated_at=$5,version=version+1
    WHERE tenant_id=$1 AND job_id=$2 AND state='leased' AND lease_owner=$3 AND version=$4 AND lease_expires_at>$5 RETURNING *
   ), finished AS (
    UPDATE wimblo_platform.durable_job_attempts a SET finished_at=$5,outcome='completed' FROM owned o
    WHERE a.tenant_id=o.tenant_id AND a.job_id=o.job_id AND a.attempt=o.attempts AND a.worker_id=$3 AND a.finished_at IS NULL RETURNING a.tenant_id,a.job_id
   ) SELECT owned.* FROM owned JOIN finished USING(tenant_id,job_id)`,[tenant,identity,worker,fence,finished]));
  if(!result.rowCount)conflict('completion');metrics.completed++;return mapJob(result.rows[0]);
 }

 async function deadLetter({tenantId,jobId:id,workerId,version,expectedVersion=version,reasonCode='ATTEMPTS_EXHAUSTED',reasonDetail='Maximum attempts exhausted.'}){
  const tenant=assertTenantId(tenantId),identity=jobId(id),worker=workerName(workerId),fence=positive(expectedVersion,'Job version',2_147_483_647),at=now(),code=bounded(reasonCode,'Dead-letter reason code',120),detail=bounded(reasonDetail,'Dead-letter reason detail',2_000);
  const result=await tenantPool.withTransaction(tenant,session=>session.query(`/*job:dead-letter*/
   WITH owned AS (
    UPDATE wimblo_platform.durable_jobs SET state='dead_lettered',lease_owner=NULL,lease_expires_at=NULL,updated_at=$5,version=version+1
    WHERE tenant_id=$1 AND job_id=$2 AND state='leased' AND lease_owner=$3 AND version=$4 AND lease_expires_at>$5 RETURNING *
   ), finished AS (
    UPDATE wimblo_platform.durable_job_attempts a SET finished_at=$5,outcome='dead_lettered',error_code=$6,error_detail=$7 FROM owned o
    WHERE a.tenant_id=o.tenant_id AND a.job_id=o.job_id AND a.attempt=o.attempts AND a.worker_id=$3 AND a.finished_at IS NULL RETURNING a.tenant_id,a.job_id
   ), recorded AS (
    INSERT INTO wimblo_platform.dead_letter_jobs(tenant_id,job_id,dead_lettered_at,reason_code,reason_detail)
    SELECT tenant_id,job_id,$5,$6,$7 FROM owned ON CONFLICT (tenant_id,job_id) DO NOTHING RETURNING tenant_id,job_id
   ) SELECT owned.* FROM owned JOIN finished USING(tenant_id,job_id) JOIN recorded USING(tenant_id,job_id)`,[tenant,identity,worker,fence,at,code,detail]));
  if(!result.rowCount)conflict('dead-letter transition');metrics.deadLetters++;return mapJob(result.rows[0]);
 }

 async function retry({tenantId,jobId:id,workerId,version,expectedVersion=version,attempts,maxAttempts,errorCode='HANDLER_FAILED',errorDetail='Job handler failed.'}){
  if(Number(attempts)>=Number(maxAttempts))return deadLetter({tenantId,jobId:id,workerId,expectedVersion,reasonCode:errorCode,reasonDetail:errorDetail});
  const tenant=assertTenantId(tenantId),identity=jobId(id),worker=workerName(workerId),fence=positive(expectedVersion,'Job version',2_147_483_647),attempt=positive(Number(attempts),'Job attempt',25),at=now(),availableAt=new Date(at.getTime()+Math.min(retryMaxMs,retryBaseMs*2**(attempt-1))),code=bounded(errorCode,'Retry error code',120),detail=bounded(errorDetail,'Retry error detail',2_000);
  const result=await tenantPool.withTransaction(tenant,session=>session.query(`/*job:retry*/
   WITH owned AS (
    UPDATE wimblo_platform.durable_jobs SET state='retry_wait',lease_owner=NULL,lease_expires_at=NULL,available_at=$6,updated_at=$5,version=version+1
    WHERE tenant_id=$1 AND job_id=$2 AND state='leased' AND lease_owner=$3 AND version=$4 AND lease_expires_at>$5 RETURNING *
   ), finished AS (
    UPDATE wimblo_platform.durable_job_attempts a SET finished_at=$5,outcome='retry',error_code=$7,error_detail=$8 FROM owned o
    WHERE a.tenant_id=o.tenant_id AND a.job_id=o.job_id AND a.attempt=o.attempts AND a.worker_id=$3 AND a.finished_at IS NULL RETURNING a.tenant_id,a.job_id
   ) SELECT owned.* FROM owned JOIN finished USING(tenant_id,job_id)`,[tenant,identity,worker,fence,at,availableAt,code,detail]));
  if(!result.rowCount)conflict('retry');metrics.retries++;return mapJob(result.rows[0]);
 }

 return Object.freeze({enqueue,enqueueInTransaction,claim,heartbeat,complete,retry,deadLetter,getMetrics:()=>Object.freeze({...metrics})});
}
