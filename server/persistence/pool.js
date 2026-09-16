// PostgreSQL connection pooling and defined failure behaviour.
//
// The point of this module is that "the database is unavailable" has exactly
// one outcome — a refused request — and never a half-written one. Specifically:
//
//   * Every connection, statement and transaction has a bounded timeout.
//   * Acquiring a connection may be retried a bounded number of times, with
//     backoff, and only for errors that prove no statement ran.
//   * A statement or transaction is NEVER retried once it may have reached the
//     server. A COMMIT whose outcome is unknown raises AMBIGUOUS_COMMIT and the
//     connection is destroyed rather than returned to the pool.
//   * Consecutive connection failures open a circuit breaker so the process
//     fails fast and closed instead of queueing work behind a dead database.
//   * Every tenant-scoped session sets wimblo.tenant_id. Row-level security
//     policies (migration 5) depend on it, and the setting function raises when
//     it is missing, so an unscoped query errors rather than reading everything.

import pg from 'pg';
import {PERSISTENCE_CODES,PersistenceError,persistenceFail,assertTenantId} from './contract.js';

const DEFAULTS=Object.freeze({
 max:10,
 min:0,
 connectionTimeoutMs:5000,
 idleTimeoutMs:30000,
 statementTimeoutMs:15000,
 transactionTimeoutMs:30000,
 acquireAttempts:3,
 retryBaseDelayMs:50,
 retryMaxDelayMs:500,
 circuitFailureThreshold:5,
 circuitOpenMs:5000,
 clientTimeoutGraceMs:2000
});

// Postgres class-08 (connection exception), 57P01-03 (admin shutdown / crash),
// 53300 (too many connections) and Node socket errors describe a connection
// that did not carry a statement to completion.
const RETRYABLE_CODES=new Set(['08000','08003','08006','08001','08004','08007','08P01','53300','57P01','57P02','57P03']);
const RETRYABLE_SYSCALL=new Set(['ECONNREFUSED','ECONNRESET','ENOTFOUND','EHOSTUNREACH','ENETUNREACH','EPIPE','ETIMEDOUT']);
const TIMEOUT_CODES=new Set(['57014','55P03']);

export function classifyError(error){
 if(error instanceof PersistenceError)return error;
 const code=error?.code;
 // A boundary error raised by caller code inside a session keeps its meaning
 // instead of being flattened into an availability failure.
 if(typeof code==='string'&&Object.values(PERSISTENCE_CODES).includes(code))return new PersistenceError(code,error.message,error.detail||{});
 if(TIMEOUT_CODES.has(code)||/query read timeout/i.test(error?.message||''))return new PersistenceError(PERSISTENCE_CODES.TIMEOUT,`Database statement exceeded its timeout and was cancelled: ${error.message}`,{pgCode:code});
 if(code==='42501'||/wimblo\.tenant_id/.test(error?.message||''))return new PersistenceError(PERSISTENCE_CODES.ISOLATION,`Tenant scope was missing or refused: ${error.message}`,{pgCode:code});
 if(code==='23505')return new PersistenceError(PERSISTENCE_CODES.CONFLICT,error.message,{pgCode:code});
 if(code==='23514'||code==='23503'||code==='22P02'||code==='22007')return new PersistenceError(PERSISTENCE_CODES.INVALID,error.message,{pgCode:code});
 if(RETRYABLE_CODES.has(code)||RETRYABLE_SYSCALL.has(code)||/timeout exceeded when trying to connect/i.test(error?.message||''))return new PersistenceError(PERSISTENCE_CODES.UNAVAILABLE,`Database is unavailable: ${error.message}`,{pgCode:code,retryable:true});
 // A connection that dropped while a statement was in flight is unavailable and
 // is deliberately NOT marked retryable: the statement may have reached the server.
 if(/connection terminated|server closed the connection/i.test(error?.message||''))return new PersistenceError(PERSISTENCE_CODES.UNAVAILABLE,`Database connection was lost mid-statement; nothing is replayed: ${error.message}`,{pgCode:code});
 return new PersistenceError(PERSISTENCE_CODES.UNAVAILABLE,`Database call failed: ${error?.message||error}`,{pgCode:code});
}
const retryable=error=>classifyError(error).detail?.retryable===true;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export function createPostgresPool(options={}){
 const config={...DEFAULTS,...options};
 for(const key of ['max','connectionTimeoutMs','idleTimeoutMs','statementTimeoutMs','transactionTimeoutMs','acquireAttempts','circuitFailureThreshold','circuitOpenMs','clientTimeoutGraceMs'])
  if(!Number.isSafeInteger(config[key])||config[key]<1)persistenceFail(PERSISTENCE_CODES.INVALID,`Pool option ${key} must be a positive integer.`);
 if(config.acquireAttempts>10)persistenceFail(PERSISTENCE_CODES.INVALID,'Pool retry limit must not exceed 10 attempts; unbounded retry hides an outage.');
 if(!config.connectionString&&!config.host)persistenceFail(PERSISTENCE_CODES.INVALID,'An explicit connection string or host is required; no database is discovered implicitly.');

 const pool=new pg.Pool({
  connectionString:config.connectionString,
  host:config.host,port:config.port,user:config.user,password:config.password,database:config.database,
  ssl:config.ssl,
  max:config.max,min:config.min,
  connectionTimeoutMillis:config.connectionTimeoutMs,
  idleTimeoutMillis:config.idleTimeoutMs,
  // The server-side statement timeout is authoritative so a cancelled statement
  // reports 57014 and the connection stays usable. The client-side timer is only
  // a backstop for a server that never answers at all, so it is given a margin.
  statement_timeout:config.statementTimeoutMs,
  query_timeout:config.statementTimeoutMs+config.clientTimeoutGraceMs,
  idle_in_transaction_session_timeout:config.transactionTimeoutMs,
  application_name:config.applicationName||'wimblo-persistence'
 });
 // A dropped connection must not become an unhandled 'error' event that takes
 // the process down. The pool discards the client; leases attach their own
 // listener for the window in which a client is checked out.
 pool.on('error',()=>{});

 let consecutiveFailures=0,openedAt=0,closed=false;
 const stats={acquisitions:0,acquireRetries:0,circuitRejections:0,ambiguousCommits:0,rollbacks:0};

 const circuitOpen=()=>consecutiveFailures>=config.circuitFailureThreshold&&Date.now()-openedAt<config.circuitOpenMs;

 async function acquire(){
  if(closed)persistenceFail(PERSISTENCE_CODES.UNAVAILABLE,'The persistence pool is closed.');
  if(circuitOpen()){stats.circuitRejections++;persistenceFail(PERSISTENCE_CODES.UNAVAILABLE,`Database circuit is open after ${consecutiveFailures} consecutive connection failures; requests are refused rather than queued.`,{circuitOpen:true});}
  let lastError=null;
  for(let attempt=1;attempt<=config.acquireAttempts;attempt++){
   try{
    const client=await pool.connect();
    consecutiveFailures=0;stats.acquisitions++;
    return client;
   }catch(e){
    lastError=e;
    if(!retryable(e)||attempt===config.acquireAttempts)break;
    stats.acquireRetries++;
    await delay(Math.min(config.retryBaseDelayMs*2**(attempt-1),config.retryMaxDelayMs));
   }
  }
  consecutiveFailures++;
  if(consecutiveFailures===config.circuitFailureThreshold)openedAt=Date.now();
  throw classifyError(lastError);
 }

 // A lease owns the checked-out client's lifetime, including the 'error' event
 // a server-side termination emits on it.
 async function lease(){
  const client=await acquire();
  const swallow=()=>{};
  client.on('error',swallow);
  let released=false;
  return {
   client,
   query:(text,values)=>run(client,text,values),
   release(destroy=false){
    if(released)return;
    released=true;
    client.removeListener('error',swallow);
    try{client.release(destroy);}catch{}
   }
  };
 }

 async function run(client,text,values){
  try{return await client.query(text,values);}
  catch(e){throw classifyError(e);}
 }

 // Administrative session: no tenant scope, no implicit transaction. Used only
 // by the explicit migration runner and by verification tooling.
 async function withAdminSession(fn){
  const held=await lease();
  try{return await fn({query:held.query});}
  finally{held.release();}
 }

 const scope=(held,tenantId,local)=>held.query('SELECT set_config($1,$2,$3)',['wimblo.tenant_id',tenantId,local]);

 // Tenant-scoped, non-transactional session (reads). The GUC is reset before
 // the connection returns to the pool so a later borrower cannot inherit it.
 async function withTenantSession(tenantId,fn){
  const tenant=assertTenantId(tenantId);
  const held=await lease();
  try{
   await scope(held,tenant,false);
   return await fn({query:held.query,tenantId:tenant});
  }finally{
   try{await held.query('SELECT set_config($1,$2,$3)',['wimblo.tenant_id','',false]);held.release();}
   catch{held.release(true);}
  }
 }

 /**
  * Tenant-scoped transaction. All-or-nothing, never retried.
  *
  * If COMMIT itself fails, the outcome is unknown to this process: the server
  * may have committed before the connection dropped. That case raises
  * AMBIGUOUS_COMMIT and destroys the connection. It is never converted into a
  * retry, because a retry of a partially-applied financial write is exactly the
  * failure mode this boundary exists to prevent.
  */
 async function withTransaction(tenantId,fn){
  const tenant=assertTenantId(tenantId);
  const held=await lease();
  let began=false,committed=false,poisoned=false;
  try{
   await held.query('BEGIN');
   began=true;
   await scope(held,tenant,true);
   const result=await fn({query:held.query,tenantId:tenant});
   try{await held.query('COMMIT');committed=true;}
   catch(e){
    stats.ambiguousCommits++;poisoned=true;
    throw new PersistenceError(PERSISTENCE_CODES.AMBIGUOUS,`Commit outcome is unknown and was not retried: ${e.message}. Reconcile before any replay.`,{pgCode:e.code});
   }
   return result;
  }catch(e){
   if(began&&!committed&&!poisoned){
    stats.rollbacks++;
    try{await held.query('ROLLBACK');}catch{poisoned=true;}
   }
   throw classifyError(e);
  }finally{held.release(poisoned);}
 }

 async function healthy(){
  try{await withAdminSession(session=>session.query('SELECT 1'));return true;}
  catch{return false;}
 }

 async function end(){closed=true;await pool.end();}

 return {
  kind:'postgres-pool',
  config:Object.freeze({...config,password:config.password?'[redacted]':undefined,connectionString:config.connectionString?'[redacted]':undefined}),
  withAdminSession,withTenantSession,withTransaction,healthy,end,
  get stats(){return {...stats,consecutiveFailures,circuitOpen:circuitOpen(),idle:pool.idleCount,total:pool.totalCount,waiting:pool.waitingCount};}
 };
}

export function poolFromEnv(env=process.env,overrides={}){
 if(!env.DATABASE_URL)persistenceFail(PERSISTENCE_CODES.INVALID,'DATABASE_URL is required; the persistence boundary never guesses a database.');
 const production=env.NODE_ENV==='production';
 const url=new URL(env.DATABASE_URL);
 if(production&&!['require','verify-ca','verify-full'].includes(url.searchParams.get('sslmode')||''))persistenceFail(PERSISTENCE_CODES.INVALID,'Production DATABASE_URL must require TLS (sslmode=require or stronger).');
 return createPostgresPool({connectionString:env.DATABASE_URL,...overrides});
}
