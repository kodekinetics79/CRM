// Worker half of the synchronous PostgreSQL driver. See syncPostgres.js for the
// protocol and the reasoning; this file only owns the connection and answers.
//
// It holds exactly ONE pg.Client for its whole life. Not a pool: BEGIN/COMMIT/
// ROLLBACK and every guard that runs inside them are per-connection state, so a
// second connection would silently break transaction semantics.

import {parentPort,workerData} from 'node:worker_threads';
import pg from 'pg';

const {control,payload,url,connectionTimeoutMs,statementTimeoutMs}=workerData;
const flag=new Int32Array(control),bytes=Buffer.from(payload);
const SIGNAL=0,STATUS=1,LENGTH=2,OK=1,OVERFLOW=2;

// Type parsing is decided here, once, and is local to this thread (pg's parser
// registry is per-isolate). The rule is: nothing that could lose exactness or
// change a stored representation is parsed. Integers and numerics stay text and
// are coerced on the main thread where the safe-integer check can throw at the
// caller; dates/times/json stay exactly the text the column holds, because the
// application stores ISO strings and JSON text and parses them itself; bytea
// becomes base64 so it survives the JSON transport as an exact byte sequence.
const identity=v=>v;
for(const oid of [20,1700,1082,1083,1114,1184,1266,114,3802,790])pg.types.setTypeParser(oid,identity);
pg.types.setTypeParser(17,v=>Buffer.from(v.slice(2),'hex').toString('base64'));

// A reply must reach a main thread that is already blocked in Atomics.wait, so
// every path below — including a thrown bug in this file — has to end in reply().
function reply(value){
 const text=JSON.stringify(value),length=Buffer.byteLength(text,'utf8');
 if(length>bytes.length){Atomics.store(flag,LENGTH,length);Atomics.store(flag,STATUS,OVERFLOW);}
 else{bytes.write(text,0,'utf8');Atomics.store(flag,LENGTH,length);Atomics.store(flag,STATUS,OK);}
 Atomics.store(flag,SIGNAL,1);Atomics.notify(flag,SIGNAL);
}

let client=null,txStatus='I',dead=null;
const FATAL=/^08|^57P0|^XX/,fatalError=e=>typeof e?.code==='string'&&FATAL.test(e.code)||/connection terminated|server closed the connection|socket hang up/i.test(e?.message||'');
const describe=e=>({ok:false,tx:txStatus,fatal:fatalError(e)||Boolean(dead),message:String(e?.message??e),code:e?.code??null,
 detail:e?.detail??null,hint:e?.hint??null,constraint:e?.constraint??null,table:e?.table??null,column:e?.column??null,
 schema:e?.schema??null,routine:e?.routine??null,severity:e?.severity??null,position:e?.position??null,where:e?.where??null});

process.on('uncaughtException',e=>{dead=e;reply(describe(e));});
process.on('unhandledRejection',e=>{dead=e;reply(describe(e));});

// Values cross the SharedArrayBuffer as JSON, which has no bigint and no bytes.
const restore=v=>v&&typeof v==='object'?('$b64' in v?Buffer.from(v.$b64,'base64'):'$n' in v?v.$n:v):v;

async function run(message){
 if(dead)return reply(describe(dead));
 try{
  if(message.op==='close'){const c=client;client=null;dead=new Error('The database connection is closed.');reply({ok:true,tx:'I',rows:[],fields:[],rowCount:0});await c?.end().catch(()=>{});return;}
  if(message.op==='exec'){
   // Simple query protocol: multiple statements in one round trip, and no
   // hand-rolled ';' splitting, which would cut CREATE TRIGGER bodies in half.
   await client.query(message.text);
   return reply({ok:true,tx:txStatus,rows:[],fields:[],rowCount:0});
  }
  const result=await client.query({text:message.text,values:(message.values||[]).map(restore),rowMode:'array'});
  const last=Array.isArray(result)?result[result.length-1]:result;
  reply({ok:true,tx:txStatus,rows:last.rows||[],fields:(last.fields||[]).map(f=>[f.name,f.dataTypeID]),rowCount:last.rowCount??0});
 }catch(e){if(fatalError(e))dead=e;reply(describe(e));}
}

try{
 // The server-side statement_timeout is authoritative (a cancelled statement
 // reports 57014 and leaves the connection usable); query_timeout is only a
 // backstop for a server that never answers, so it is given a margin.
 client=new pg.Client({connectionString:url,connectionTimeoutMillis:connectionTimeoutMs,statement_timeout:statementTimeoutMs,query_timeout:statementTimeoutMs+2000,application_name:'wimblo-sync'});
 // The backend's own transaction indicator, not a guess parsed out of the SQL:
 // 'T' in a block, 'E' in a failed block that still needs ROLLBACK, 'I' idle.
 client.connection.on('readyForQuery',m=>{txStatus=m.status;});
 client.on('error',e=>{dead=e;});
 await client.connect();
 parentPort.on('message',run);
 parentPort.postMessage({ok:true});
}catch(e){parentPort.postMessage({ok:false,message:String(e?.message??e),code:e?.code??null});}
