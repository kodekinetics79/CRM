// Synchronous PostgreSQL, presenting the `node:sqlite` DatabaseSync surface.
//
// The application holds 2,159 synchronous db.prepare(...) call sites and every
// integrity guard in this codebase runs inside a synchronous transaction. This
// module keeps that shape instead of rewriting it: a worker thread owns one pg
// Client, the main thread posts a request into a SharedArrayBuffer and blocks in
// Atomics.wait until the worker writes the reply and notifies.
//
// One hard constraint, proven against a real instance: Node's worker bootstrap
// needs the parent event loop to run, so blocking immediately after new Worker()
// hangs forever. The handle is therefore produced by an ASYNC factory that waits
// for the worker to be online and connected. Everything the factory returns is
// synchronous; nothing after startup awaits.
//
// Deliberate properties:
//   * ONE dedicated client, never a pool. BEGIN/COMMIT/ROLLBACK, advisory state
//     and every guard inside a transaction are per-connection; a second
//     connection would break them silently.
//   * A result that does not fit the shared buffer throws. It is never truncated
//     and a partial row set is never returned.
//   * A worker crash, lost connection or timeout surfaces as a throw on the call
//     that hit it, and poisons the handle so the next call throws too. The main
//     thread is blocked while a query is in flight, so a failure can never be
//     reported through an event handler — it has to come back through the buffer
//     or through the Atomics.wait timeout.
//   * No float coercion anywhere. Integers arrive as text and become JS numbers
//     only when they are exactly representable; otherwise the read throws.
//
// This module is dialect-free on purpose. It does not rewrite `?` placeholders,
// `INSERT OR IGNORE` or `BEGIN IMMEDIATE`; that is Stage 2's job
// (server/persistence/sqliteDialect.js). SQL is sent to PostgreSQL verbatim,
// with one documented exception: see lastInsertRowid below.

import {Worker} from 'node:worker_threads';

const SIGNAL=0,STATUS=1,LENGTH=2,PENDING=0,OK=1,OVERFLOW=2;
const DEFAULTS=Object.freeze({bufferBytes:64*1024*1024,timeoutMs:30000,connectionTimeoutMs:10000,statementTimeoutMs:15000});
const INT2=21,INT4=23,INT8=20,NUMERIC=1700,BYTEA=17;
const fail=message=>{throw new Error(message);};

// `INSERT INTO <table>` with nothing but whitespace and comments in front. A CTE,
// a subquery form or anything else simply does not match, and then run() reports
// lastInsertRowid 0 rather than guessing.
const INSERT_TARGET=/^\s*insert\s+into\s+((?:"(?:[^"]|"")+"|[A-Za-z_-￿][\w$-￿]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[A-Za-z_-￿][\w$-￿]*))?)/i;
const HAS_RETURNING=/\breturning\b/i,IS_DDL=/\b(create|alter|drop|truncate|comment)\b/i;

const safeInteger=text=>{
 const value=Number(text);
 if(!Number.isSafeInteger(value))fail(`Integer ${text} is outside JavaScript's safe integer range; read this column with setReadBigInts(true).`);
 return value;
};
// Exactness over convenience: an integral numeric becomes a JS number, a numeric
// carrying a fraction is handed back as the exact text PostgreSQL produced. It is
// never turned into a float, because money in this schema is integer cents and a
// fractional numeric means a query — not the schema — introduced it.
const decode=(oid,value,bigints)=>{
 if(value===null||value===undefined)return null;
 switch(oid){
  case INT8:return bigints?BigInt(value):safeInteger(value);
  case INT2:case INT4:return bigints?BigInt(value):value;
  case NUMERIC:return /^-?\d+$/.test(value)?(bigints?BigInt(value):safeInteger(value)):value;
  case BYTEA:return Uint8Array.from(Buffer.from(value,'base64'));
  default:return value;
 }
};
// node:sqlite hands back [Object: null prototype] rows; deep-equal assertions in
// the suite see the prototype, so these are built the same way.
const shape=(fields,row,bigints)=>{const out=Object.create(null);for(let i=0;i<fields.length;i++)out[fields[i][0]]=decode(fields[i][1],row[i],bigints);return out;};

const encode=value=>{
 if(typeof value==='bigint')return value.toString();
 if(value instanceof Uint8Array)return {$b64:Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString('base64')};
 if(value===undefined)return null;
 if(typeof value==='number'||typeof value==='string'||typeof value==='boolean'||value===null)return value;
 fail(`Unsupported parameter type ${value===null?'null':typeof value}; pass a number, bigint, string, boolean, null or Uint8Array.`);
};

function raise(reply){
 // The PostgreSQL message is reproduced byte for byte: trigger refusals such as
 // 'Audit is append-only' are asserted by tests and shown to users.
 const error=new Error(reply.message);
 for(const key of ['code','detail','hint','constraint','table','column','schema','routine','severity','position','where'])if(reply[key]!==null&&reply[key]!==undefined)error[key]=reply[key];
 throw error;
}

export async function createSyncPostgres(options={}){
 const config={...DEFAULTS,...options};
 const url=config.url??config.connectionString;
 if(typeof url!=='string'||!url)fail('createSyncPostgres requires an explicit connection URL; no database is discovered implicitly.');
 for(const key of ['bufferBytes','timeoutMs','connectionTimeoutMs','statementTimeoutMs'])if(!Number.isSafeInteger(config[key])||config[key]<1)fail(`createSyncPostgres option ${key} must be a positive integer.`);
 if(config.bufferBytes<64*1024)fail('createSyncPostgres bufferBytes must be at least 64 KiB.');

 const control=new SharedArrayBuffer(16),payload=new SharedArrayBuffer(config.bufferBytes);
 const flag=new Int32Array(control),bytes=Buffer.from(payload);
 const worker=new Worker(new URL('./syncPostgresWorker.js',import.meta.url),{workerData:{control,payload,url,connectionTimeoutMs:config.connectionTimeoutMs,statementTimeoutMs:config.statementTimeoutMs}});

 // Startup is the one and only await. A connect failure has to be reported here,
 // because once the main thread starts blocking no event handler can ever run.
 const started=await new Promise(resolve=>{
  worker.once('message',m=>resolve(m));
  worker.once('error',e=>resolve({ok:false,message:String(e?.message??e)}));
  worker.once('exit',code=>resolve({ok:false,message:`Database worker exited during startup with code ${code}.`}));
 });
 if(!started?.ok){await worker.terminate().catch(()=>{});fail(`Database worker could not connect: ${started?.message||'unknown failure'}`);}
 worker.unref();

 let open=true,poisoned=null,inFlight=false,tx='I';
 // Nothing can run on the main thread while a query is in flight, so these only
 // ever fire between calls — which is exactly when they are useful.
 worker.on('error',e=>{poisoned=poisoned||`Database worker failed: ${String(e?.message??e)}`;});
 worker.on('exit',code=>{if(open)poisoned=poisoned||`Database worker exited unexpectedly with code ${code}.`;});

 function call(message){
  if(!open)fail('The database is not open.');
  if(poisoned)fail(poisoned);
  if(inFlight)fail('A database call is already in flight; the synchronous driver cannot be re-entered.');
  inFlight=true;
  Atomics.store(flag,SIGNAL,PENDING);Atomics.store(flag,STATUS,PENDING);Atomics.store(flag,LENGTH,0);
  worker.postMessage(message);
  try{
   while(Atomics.load(flag,SIGNAL)===PENDING){
    if(Atomics.wait(flag,SIGNAL,PENDING,config.timeoutMs)==='timed-out'){
     // The worker may still write this reply later, so the buffer can no longer
     // be trusted. Refusing every further call is the only safe outcome.
     poisoned=`Database call did not answer within ${config.timeoutMs} ms; the connection has been abandoned.`;
     worker.terminate().catch(()=>{});
     fail(poisoned);
    }
   }
   const status=Atomics.load(flag,STATUS),length=Atomics.load(flag,LENGTH);
   if(status===OVERFLOW)fail(`Result of ${length} bytes exceeds the ${payload.byteLength}-byte shared result buffer; narrow the query or raise bufferBytes. No rows were returned.`);
   const reply=JSON.parse(bytes.toString('utf8',0,length));
   if(reply.fatal)poisoned=`Database connection was lost: ${reply.message}`;
   tx=reply.tx??tx;
   if(!reply.ok)raise(reply);
   return reply;
  }finally{inFlight=false;}
 }

 const identity=new Map();
 // lastInsertRowid needs a value PostgreSQL only returns if it is asked for, so
 // an INSERT into a table with an identity/serial column gets a RETURNING clause
 // appended. The catalog answer is cached per table and dropped whenever DDL runs.
 function identityColumn(table){
  if(identity.has(table))return identity.get(table);
  let column=null;
  try{
   // Catalog reads only. to_regclass() answers NULL for an unknown name and
   // pg_attrdef is inspected instead of pg_get_serial_sequence(), because both
   // of those raise — and a raise inside an open transaction would abort it.
   const rows=call({op:'query',text:`SELECT a.attname FROM pg_attribute a WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped AND (a.attidentity IN ('a','d') OR EXISTS(SELECT 1 FROM pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum AND pg_get_expr(d.adbin,d.adrelid) LIKE 'nextval(%')) ORDER BY a.attnum LIMIT 1`,values:[table]}).rows;
   column=rows.length?rows[0][0]:null;
  }catch{return null;} // An unknown table or an aborted transaction: report 0 and let the real statement produce the real error.
  identity.set(table,column);
  return column;
 }

 function statement(sql){
  if(typeof sql!=='string')fail('SQL must be a string.');
  let bigints=false;
  const target=INSERT_TARGET.exec(sql),table=target&&!HAS_RETURNING.test(sql)?target[1]:null;
  const query=values=>call({op:'query',text:sql,values:values.map(encode)});
  const rows=values=>{const reply=query(values);return {reply,list:reply.rows.map(row=>shape(reply.fields,row,bigints))};};
  return {
   get(...values){const list=rows(values).list;return list.length?list[0]:undefined;},
   all(...values){return rows(values).list;},
   // Buffered, not streamed: the whole result crosses the shared buffer in one
   // reply. Callers that break early keep working; memory profile differs.
   iterate(...values){
    const list=rows(values).list;let index=0;
    const iterator={next:()=>index<list.length?{value:list[index++],done:false}:{value:undefined,done:true},return:()=>{index=list.length;return {value:undefined,done:true};},[Symbol.iterator]:()=>iterator};
    return iterator;
   },
   run(...values){
    const column=table?identityColumn(table):null;
    const reply=column?call({op:'query',text:`${sql.replace(/;?\s*$/,'')} RETURNING "${column.replaceAll('"','""')}"`,values:values.map(encode)}):query(values);
    const changes=bigints?BigInt(reply.rowCount??0):reply.rowCount??0;
    // A multi-row INSERT reports the LAST identity assigned, as SQLite does.
    const last=column&&reply.rows.length?decode(reply.fields[0][1],reply.rows[reply.rows.length-1][0],bigints):null;
    return {changes,lastInsertRowid:last??(bigints?0n:0)};
   },
   setReadBigInts(value){if(typeof value!=='boolean')fail('setReadBigInts expects a boolean.');bigints=value;},
   get sourceSQL(){return sql;}
  };
 }

 return {
  exec(sql){
   if(typeof sql!=='string')fail('SQL must be a string.');
   if(IS_DDL.test(sql))identity.clear();
   call({op:'exec',text:sql});
  },
  prepare:statement,
  close(){if(!open)return;try{if(!poisoned)call({op:'close'});}catch{}finally{open=false;worker.terminate().catch(()=>{});}},
  get isTransaction(){return tx==='T'||tx==='E';},
  get isOpen(){return open;},
  get bufferBytes(){return payload.byteLength;}
 };
}

export default createSyncPostgres;
