// node:sqlite-compatible adapter over pre-warmed synchronous PostgreSQL handles.
//
// openDatabase(path) is synchronous and ~100 call sites depend on that, but a
// syncPostgres handle can only be created asynchronously (the worker must be
// online before the main thread may block). So handles are warmed up front by
// createPostgresPool() and handed out synchronously by openPostgresDatabase().
//
// Mapping of SQLite concepts:
//   * A database file becomes a schema. The schema name is a hash of the resolved
//     path, so closing and reopening the same path finds the same data. ':memory:'
//     (and '', SQLite's private temporary database) gets a fresh schema that is
//     dropped again on close, as the SQLite database would vanish (unless the pool
//     defers that to a sequential sweep; see dropMemorySchemas).
//   * close() does not terminate the connection. It rolls back any open
//     transaction, runs DISCARD ALL (search_path, lock_timeout, read-only mode,
//     advisory locks, temp tables) and returns the handle to the pool.
//   * {readOnly:true} opens only an existing schema (as SQLite refuses to create a
//     file read-only) and sets default_transaction_read_only for the session. The
//     server then refuses every INSERT/UPDATE/DELETE/DDL with SQLSTATE 25006,
//     including writes inside an explicit BEGIN; nothing is guessed from SQL text.
//     DISCARD ALL on close resets it before the handle is reused.
//   * A SQLite statement that fails inside a transaction undoes only itself; a
//     PostgreSQL one aborts the whole transaction. Inside a transaction each
//     statement is therefore bracketed by a savepoint so a caught failure leaves
//     the transaction usable, exactly as the SQLite code paths expect.
//   * `DROP TRIGGER name` names no table, which PostgreSQL requires. The adapter
//     resolves the table from pg_trigger in this schema, refuses a name found on more
//     than one table, and also drops the generated `<trigger>_raise_<hash>` function
//     when no other trigger uses it, so nothing of the SQLite trigger is left behind.
//   * PostgreSQL NOTICE/WARNING messages are never errors (the driver ignores them).
//
// Recovery from a poisoned handle. The driver poisons a handle for good after a lost
// connection or a timeout, because its shared buffer can no longer be trusted. The
// adapter must not turn that into a permanent outage:
//   * Detection: a failure carrying no SQLSTATE, or a connection/shutdown/internal
//     class (08, 57P, XX, 53), is confirmed with a trivial probe. A probe that also
//     fails that way means the handle is dead. Ordinary SQL errors never probe.
//   * The dead handle is terminated and a replacement is warmed ASYNCHRONOUSLY, off
//     the blocked call path, single-flight per database (a second observer joins the
//     rebuild in progress; no second worker is started). Failed attempts back off
//     from 250 ms to 5 s until the database is closed.
//   * While rebuilding, every call fails immediately with status 503 and code
//     WIMBLO_DATABASE_UNAVAILABLE; nothing blocks or hangs.
//   * The replacement re-establishes search_path (and read-only mode) and verifies
//     current_schema() before it is installed, so it can never serve another schema.
//   * A transaction open when the handle died is gone and is never reported as
//     committed. isTransaction stays true and every statement except ROLLBACK fails
//     with code WIMBLO_TRANSACTION_LOST (503) until the caller rolls back; ROLLBACK
//     then succeeds as a no-op, so a caller's `catch{ROLLBACK;throw e}` keeps the
//     original error. A COMMIT that was itself in flight is equally ambiguous and is
//     treated the same way: whether it landed must be read back, never assumed.
//
// This module does no dialect work of its own: DDL goes through sqliteDdl.js and
// everything else through sqliteQuery.js.

import {createHash,randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {createSyncPostgres} from './syncPostgres.js';
import {translateDdl,preludeStatements,splitStatements as splitScript} from './sqliteDdl.js';
import {translateQuery,translateExec,ROWID_COLUMN} from './sqliteQuery.js';

const fail=message=>{throw new Error(message);};
const failWith=(status,code,message)=>{throw Object.assign(new Error(message),{status,code});};
const quoteIdent=name=>'"'+name.replaceAll('"','""')+'"';
const quoteLiteral=value=>"'"+String(value).replaceAll("'","''")+"'";
// Leading whitespace and comments are skipped when classifying a statement.
const LEAD=String.raw`^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*`;
const DDL=new RegExp(LEAD+String.raw`(create|alter|drop)\b`,'i');
const TX_CONTROL=new RegExp(LEAD+String.raw`(begin|commit|end|rollback|savepoint|release)\b`,'i');
const PLAIN_ROLLBACK=new RegExp(LEAD+String.raw`rollback(\s+transaction)?\s*;?\s*$`,'i');
const DROP_TRIGGER=new RegExp(LEAD+String.raw`drop\s+trigger\s+(if\s+exists\s+)?(?:(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)\s*\.\s*)?("(?:[^"]|"")+"|[A-Za-z_][\w$]*)\s*;?\s*$`,'i');
// syncPostgres caches identity columns by unqualified table name and clears that cache on any exec whose
// text names DDL. A handle moving between schemas must not keep another schema's answers, so these execs say so.
const CLEAR_IDENTITY=' /* schema switch: drop cached identity columns */';
// Anything that changes what the support objects are forces a reinstall into schemas made by an older build.
const SUPPORT_MARK='wimblo-support:'+createHash('sha256').update(preludeStatements().join(';\n')).digest('hex').slice(0,16);
const EXEC_CHUNK=24;
const SQLSTATE=/^[0-9A-Z]{5}$/,CONNECTION_CLASS=/^(08|57P|XX|53)/;
const sqlError=e=>typeof e?.code==='string'&&SQLSTATE.test(e.code)&&!CONNECTION_CLASS.test(e.code);
const sleep=ms=>new Promise(r=>{const t=setTimeout(r,ms);t.unref?.();});

// The handle is unusable only if the failure carries no ordinary SQLSTATE AND a trivial probe fails the
// same way. The probe costs one round trip and runs only on such failures, never on a normal SQL error.
function handleDead(handle,error){
 if(!handle.isOpen)return true;
 if(sqlError(error))return false;
 try{handle.prepare('SELECT 1').get();return false;}catch(probe){return !sqlError(probe);}
}

// onError(event) observes every failed statement ({schema,source,translated,error}) for diagnosis; it cannot alter the throw.
// dropMemorySchemas:false leaves a closed ':memory:' schema for a later sequential sweep (the test harness does
// this): DROP SCHEMA CASCADE locks every object in one transaction, and many concurrent drops of a full
// workspace schema exhaust the server's shared lock table (max_locks_per_transaction x max_connections).
export async function createPostgresPool({url,size=4,schemaPrefix='wimblo_',driver={},onError=null,dropMemorySchemas=true}={}){
 if(typeof url!=='string'||!url)fail('createPostgresPool requires an explicit connection URL.');
 if(!Number.isSafeInteger(size)||size<1)fail('createPostgresPool size must be a positive integer.');
 if(!/^[a-z_][a-z0-9_]{0,30}$/.test(schemaPrefix))fail('createPostgresPool schemaPrefix must be a lowercase identifier of at most 31 bytes.');
 const create=()=>createSyncPostgres({url,...driver});
 const idle=await Promise.all(Array.from({length:size},create));
 const busy=new Set(),refills=new Set(),schemas=new Set();
 let closed=false,peak=0,lastRefillError=null;
 // A replacement retries with backoff until it connects or the pool closes: after a server restart every pooled
 // handle dies at once, and a refill that gave up on "the database system is in recovery mode" would shrink the pool for good.
 const refill=()=>{const p=(async()=>{for(let delay=250;!closed;delay=Math.min(delay*2,5000)){try{const h=await create();if(closed)h.close();else{idle.push(h);lastRefillError=null;}return;}catch(e){lastRefillError=e.message;await sleep(delay);}}})().finally(()=>refills.delete(p));refills.add(p);};
 return {url,size,schemaPrefix,schemas,onError,dropMemorySchemas,
  acquire(path){
   if(closed)fail('The PostgreSQL pool is closed.');
   const handle=idle.pop();
   if(!handle)failWith(503,'WIMBLO_POOL_EXHAUSTED',`PostgreSQL pool exhausted: all ${size} pre-warmed handles are open (pool size ${size}${refills.size?`, ${refills.size} replacement(s) still warming`:''}${lastRefillError?`, last replacement failed: ${lastRefillError}`:''}). Close a database before opening ${path}, or raise the pool size.`);
   busy.add(handle);peak=Math.max(peak,busy.size);return handle;
  },
  release(handle){
   busy.delete(handle);
   if(closed){try{handle.close();}catch{}return;}
   if(handle.isOpen){idle.push(handle);return;}
   refill(); // A lost handle is replaced in the background; the event loop runs between requests.
  },
  // A dead handle that an open database replaces itself: terminated and forgotten, without a pool refill.
  discard(handle){busy.delete(handle);try{handle.close();}catch{}},
  async warm(){if(closed)fail('The PostgreSQL pool is closed.');const h=await create();if(closed){h.close();fail('The PostgreSQL pool is closed.');}return h;},
  adopt(handle){busy.add(handle);peak=Math.max(peak,busy.size);},
  get closed(){return closed;},
  get stats(){return {size,idle:idle.length,busy:busy.size,peak,warming:refills.size,schemas:schemas.size};},
  async close(){closed=true;await Promise.allSettled([...refills]);for(const h of idle.splice(0))try{h.close();}catch{}for(const h of busy)try{h.close();}catch{}busy.clear();}
 };
}

export function schemaNameFor(path,prefix='wimblo_'){
 if(path===':memory:'||path===''||path===undefined||path===null)return `${prefix}mem_${randomBytes(12).toString('hex')}`;
 const target=String(path).startsWith('file:')?String(path):resolve(String(path));
 return `${prefix}${createHash('sha256').update(target,'utf8').digest('hex').slice(0,32)}`;
}

// Points a handle at the schema and proves it. Used on open and after every rebuild.
function attach(handle,schema,{readOnly,install}){
 const s=quoteIdent(schema);
 if(readOnly){
  if(!handle.prepare('SELECT 1 FROM pg_namespace WHERE nspname=$1').get(schema))fail('unable to open database file');
  handle.exec(`SET search_path TO ${s}; SET default_transaction_read_only=on`+CLEAR_IDENTITY);
 }else{
  handle.exec(`CREATE SCHEMA IF NOT EXISTS ${s}; SET search_path TO ${s}`+CLEAR_IDENTITY);
  if(install&&handle.prepare("SELECT obj_description(oid,'pg_namespace') AS mark FROM pg_namespace WHERE nspname=$1").get(schema)?.mark!==SUPPORT_MARK)
   // Serialised per schema so two openers of one path cannot race CREATE OR REPLACE FUNCTION.
   handle.exec(`BEGIN; SELECT pg_advisory_xact_lock(hashtext(${quoteLiteral(schema)})); ${preludeStatements().join(';\n')}; COMMENT ON SCHEMA ${s} IS ${quoteLiteral(SUPPORT_MARK)}; COMMIT`);
 }
 const current=handle.prepare('SELECT current_schema() AS s').get()?.s;
 if(current!==schema)fail(`Refusing a database handle whose schema is ${current}, not ${schema}.`);
}

// A workspace exists on PostgreSQL when its schema exists: the counterpart of a SQLite file.
export function postgresDatabaseExists(pool,path){
 if(path===':memory:'||path===''||path===undefined||path===null)return false;
 const handle=pool.acquire(path);
 try{return Boolean(handle.prepare('SELECT 1 FROM pg_namespace WHERE nspname=$1').get(schemaNameFor(path,pool.schemaPrefix)));}
 finally{pool.release(handle);}
}

export function openPostgresDatabase(pool,path,options={}){
 const memory=path===':memory:'||path===''||path===undefined||path===null;
 const readOnly=Boolean(options?.readOnly),schema=schemaNameFor(path,pool.schemaPrefix);
 if(Buffer.byteLength(schema)>63)fail(`Schema name ${schema} exceeds PostgreSQL's 63-byte identifier limit.`);
 const s=quoteIdent(schema);
 let handle;
 // A pooled handle may have died while idle (a server restart drops every connection): replace it, try the next.
 for(;;){
  const candidate=pool.acquire(path);
  try{attach(candidate,schema,{readOnly,install:true});handle=candidate;break;}
  catch(error){
   if(handleDead(candidate,error)){pool.discard(candidate);pool.release(candidate);continue;}
   try{if(candidate.isTransaction)candidate.exec('ROLLBACK');candidate.exec('DISCARD ALL'+CLEAR_IDENTITY);}catch{}
   pool.release(candidate);
   throw error;
  }
 }
 if(!readOnly)pool.schemas.add(schema);

 let open=true,generation=0,broken=false,transactionLost=false,recovering=null,armed=false;
 const recovery={rebuilds:0,attempts:0,lastError:null,lastLostAt:null,lastRecoveredAt:null,lastRecoveryMs:null};
 const columns=new Map(),notNull=new Map();
 const live=()=>{if(!open)fail('database is not open');};
 const ddlRan=()=>{columns.clear();notNull.clear();generation++;};
 const observe=(source,translated,fn)=>{try{return fn();}catch(error){try{pool.onError?.({schema,source,translated,error});}catch{}throw error;}};

 function rebuild(){
  if(recovering)return recovering;
  recovering=(async()=>{
   for(let delay=0;open&&!pool.closed;delay=Math.min(5000,Math.max(250,delay*2))){
    if(delay)await sleep(delay);
    if(!open||pool.closed)return;
    recovery.attempts++;
    let next=null;
    try{
     next=await pool.warm();
     if(!open){next.close();return;}
     attach(next,schema,{readOnly,install:false});
     pool.adopt(next);handle=next;armed=false;ddlRan();broken=false;
     recovery.rebuilds++;recovery.lastRecoveredAt=Date.now();recovery.lastRecoveryMs=recovery.lastRecoveredAt-recovery.lastLostAt;recovery.lastError=null;
     return;
    }catch(error){recovery.lastError=error.message;try{next?.close();}catch{}}
   }
  })().finally(()=>{recovering=null;});
  return recovering;
 }
 function lose(wasTransaction){
  if(broken)return;
  broken=true;armed=false;recovery.lastLostAt=Date.now();
  if(wasTransaction)transactionLost=true;
  pool.discard(handle);
  rebuild();
 }
 const unavailable=()=>failWith(503,'WIMBLO_DATABASE_UNAVAILABLE','The database connection was lost and is being re-established; retry the request shortly.');
 const lostTransaction=()=>failWith(503,'WIMBLO_TRANSACTION_LOST','The database connection was lost during this transaction. Nothing in it can be assumed committed; roll back and retry.');
 // Every use of the handle goes through here. Nesting (columnsOf inside a translation) is harmless: lose() is idempotent.
 function use(fn){
  live();
  if(transactionLost)lostTransaction();
  if(broken)unavailable();
  const current=handle,wasTransaction=current.isTransaction;
  try{return fn(current);}
  catch(error){if(!broken&&current===handle&&handleDead(current,error))lose(wasTransaction);throw error;}
 }

 // Contract with sqliteQuery.js: the name arrives lowercased if unquoted, exact if quoted, schema prefix dropped.
 function columnsOf(table){
  const key=String(table);
  if(columns.has(key))return columns.get(key);
  // `c.relname=$2::text`, never `c.relname::text=...`: a cast column cannot use pg_class_relname_nsp_index, and the
  // resulting scan of pg_class grows with EVERY workspace schema in the database (measured 28-38 ms per table with
  // ~140 schemas, 0.04-0.2 ms through the index). name=text compares exactly; a name over 63 bytes never matches.
  const names=use(h=>h.prepare(`SELECT a.attname AS name FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
   WHERE c.relnamespace=to_regnamespace($1::text) AND c.relkind IN ('r','p','v','m','f') AND c.relname=$2::text
   AND a.attnum>0 AND NOT a.attisdropped AND a.attname::text<>$3::text ORDER BY a.attnum`).all(schema,key,ROWID_COLUMN).map(r=>r.name));
  // SQLite's own words, and a miss is never cached: the table may be created next.
  if(!names.length)fail(`no such table: ${key}`);
  columns.set(key,names);
  return names;
 }

 // Contract with sqliteQuery.js: synchronous, never throws, exactly true only for a column declared NOT NULL
 // (pg_attribute.attnotnull, which covers primary keys); anything unknown is false. One catalog read per table.
 function isNotNull(table,column){
  try{
   const key=String(table);
   let set=notNull.get(key);
   if(!set){
    const rows=use(h=>h.prepare(`SELECT a.attname AS name FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
     WHERE c.relnamespace=to_regnamespace($1::text) AND c.relname=$2::text AND a.attnum>0 AND NOT a.attisdropped AND a.attnotnull`).all(schema,key));
    set=new Set(rows.map(r=>r.name));
    if(!set.size)return false; // unknown table (or none declared): not cached, the table may be created next
    notNull.set(key,set);
   }
   return set.has(String(column));
  }catch{return false;}
 }
 const dialect={columnsOf,isNotNull};

 // SQLite statement-level atomicity inside a transaction; see the header. To keep this at one extra
 // round trip per statement, a successful statement leaves its savepoint in place and the next one
 // re-arms it with `RELEASE; SAVEPOINT` in a single exec. Before any transaction-control statement
 // the pending savepoint is released first, so an application SAVEPOINT is never nested inside ours
 // (releasing ours later would silently release the application's too).
 const MARK='wimblo_statement';
 const settle=h=>{if(!h.isOpen||!h.isTransaction)armed=false;};
 function atomic(h,fn){
  settle(h);
  if(!h.isTransaction)return fn();
  h.exec(armed?`RELEASE SAVEPOINT ${MARK}; SAVEPOINT ${MARK}`:`SAVEPOINT ${MARK}`);
  armed=true;
  try{return fn();}
  catch(error){if(h.isOpen&&h.isTransaction&&sqlError(error))try{h.exec(`ROLLBACK TO SAVEPOINT ${MARK}`);}catch{armed=false;}else armed=false;throw error;}
  finally{settle(h);}
 }
 function control(h,fn){
  settle(h);
  const prefix=armed?`RELEASE SAVEPOINT ${MARK}; `:'';
  armed=false;
  try{return fn(prefix);}finally{settle(h);}
 }

 // DROP TRIGGER name -> DROP TRIGGER name ON <its table>, plus its generated function.
 function dropTrigger(statement){
  const m=DROP_TRIGGER.exec(statement);
  const name=m[2].startsWith('"')?m[2].slice(1,-1).replaceAll('""','"'):m[2].toLowerCase();
  const found=use(h=>h.prepare(`SELECT c.relname AS tbl,p.proname AS fn,n.nspname AS fnschema,
   (SELECT count(*) FROM pg_trigger o WHERE o.tgfoid=t.tgfoid AND o.oid<>t.oid)::int AS shared
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE c.relnamespace=to_regnamespace($1::text) AND t.tgname=$2::text AND NOT t.tgisinternal`).all(schema,name));
  if(found.length>1)fail(`Refusing DROP TRIGGER ${name}: it exists on ${found.length} tables (${found.map(r=>r.tbl).join(', ')}); PostgreSQL trigger names are per table.`);
  if(!found.length){if(m[1])return [];fail(`no such trigger: ${name}`);}
  const [{tbl,fn,fnschema,shared}]=found,out=[`DROP TRIGGER IF EXISTS ${quoteIdent(name)} ON ${quoteIdent(tbl)}`];
  if(!shared&&fnschema===schema&&/_raise_[0-9a-f]{8}$/.test(fn))out.push(`DROP FUNCTION IF EXISTS ${quoteIdent(fn)}()`);
  return out;
 }

 function exec(sql){
  live();
  if(typeof sql!=='string')fail('SQL must be a string.');
  // After a lost connection the transaction no longer exists; ROLLBACK is the caller acknowledging that.
  if((transactionLost||broken)&&PLAIN_ROLLBACK.test(sql)){transactionLost=false;return;}
  use(()=>{});
  let batch=[],ddl=false;
  const flush=()=>{
   if(!batch.length)return;
   const pending=batch,text=batch.join(';\n'),transactional=batch.some(b=>TX_CONTROL.test(b));
   batch=[];
   try{observe(sql,text,()=>use(h=>{
    if(transactional)return control(h,prefix=>h.exec(prefix+text));
    // Outside a transaction a multi-statement simple query is still ONE implicit transaction holding a lock on
    // every object it creates; a full workspace schema at once exhausts the shared lock table under concurrency.
    // SQLite's exec() autocommits statement by statement anyway, so chunks change nothing observable.
    if(!h.isTransaction&&pending.length>EXEC_CHUNK){for(let i=0;i<pending.length;i+=EXEC_CHUNK)h.exec(pending.slice(i,i+EXEC_CHUNK).join(';\n'));return;}
    return atomic(h,()=>h.exec(text));
   }));}
   finally{if(ddl){ddlRan();ddl=false;}}
  };
  for(const statement of splitScript(sql)){
   if(DROP_TRIGGER.test(statement)){flush();const out=observe(statement,null,()=>dropTrigger(statement));if(out.length){batch.push(...out);ddl=true;}continue;}
   if(DDL.test(statement)){
    const translated=observe(statement,null,()=>translateDdl(statement,{strict:true}));
    if(translated.statements.length){batch.push(...translated.statements);ddl=true;}
    continue;
   }
   // A statement that may expand SELECT * must see the catalog after any DDL queued ahead of it.
   if(ddl)flush();
   const text=observe(statement,null,()=>translateExec(statement,dialect)).replace(/;\s*$/,'').trim();
   if(text)batch.push(text);
  }
  flush();
 }

 function prepare(sql){
  live();
  if(typeof sql!=='string')fail('SQL must be a string.');
  // Prepared DDL (one CREATE TRIGGER becomes two PostgreSQL statements) runs through exec().
  if(DDL.test(sql)){const none={changes:0,lastInsertRowid:0};return {get:()=>{exec(sql);},all:()=>{exec(sql);return [];},run:()=>{exec(sql);return {...none};},iterate:()=>{exec(sql);return [][Symbol.iterator]();},setReadBigInts(){},get sourceSQL(){return sql;}};}
  const rollback=PLAIN_ROLLBACK.test(sql),controlling=TX_CONTROL.test(sql);
  let translatedAt=-1,boundTo=null,statement=null,bigints=false;
  // Retranslated after DDL or onto a rebuilt handle, as SQLite re-prepares a statement whose schema changed.
  const current=h=>{if(translatedAt!==generation||boundTo!==h){statement=h.prepare(observe(sql,null,()=>translateQuery(sql,dialect)));statement.setReadBigInts(bigints);translatedAt=generation;boundTo=h;}return statement;};
  use(current);
  const call=(method,values)=>{
   live();
   if(rollback&&(transactionLost||broken)){transactionLost=false;return method==='run'?{changes:0,lastInsertRowid:0}:method==='all'?[]:method==='iterate'?[][Symbol.iterator]():undefined;}
   return use(h=>{const st=current(h);return observe(sql,st.sourceSQL,()=>controlling?control(h,prefix=>{if(prefix)h.exec(prefix.trim());return st[method](...values);}):atomic(h,()=>st[method](...values)));});
  };
  return {
   get:(...values)=>call('get',values),
   all:(...values)=>call('all',values),
   run:(...values)=>call('run',values),
   // Buffered by the driver, so materialising inside the savepoint is exact.
   iterate:(...values)=>call('iterate',values),
   setReadBigInts(value){if(typeof value!=='boolean')fail('setReadBigInts expects a boolean.');bigints=value;statement?.setReadBigInts(value);},
   get sourceSQL(){return sql;}
  };
 }

 const database={
  exec,prepare,columnsOf,isNotNull,
  close(){
   if(!open)return;
   open=false;
   // A dead handle was already discarded; a rebuild in flight sees open=false and closes what it warmed.
   if(broken){if(memory)pool.schemas.delete(schema);return;}
   try{
    if(handle.isTransaction)handle.exec('ROLLBACK');
    if(memory&&pool.dropMemorySchemas)handle.exec(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    handle.exec('DISCARD ALL'+CLEAR_IDENTITY);
   }catch{try{handle.close();}catch{}}
   finally{if(memory&&pool.dropMemorySchemas)pool.schemas.delete(schema);pool.release(handle);}
  },
  // Resolves once the connection is serving again (immediately when healthy). For health checks and tests.
  async whenReady(){while(open&&broken&&recovering)await recovering;},
  get isTransaction(){return open&&(transactionLost||(!broken&&handle.isTransaction));},
  get isOpen(){return open;},
  get healthy(){return open&&!broken&&!transactionLost;},
  get recovery(){return {...recovery,broken,transactionLost,recovering:Boolean(recovering)};},
  get schema(){return schema;},
  get readOnly(){return readOnly;},
  location(){return memory?null:String(path);}
 };
 return database;
}

export default openPostgresDatabase;
