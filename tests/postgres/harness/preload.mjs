// Installs the PostgreSQL adapter behind server/persistence/openDatabase.js for a
// test process, so the UNMODIFIED suite runs against the local migration container.
//   node --import ./tests/postgres/harness/preload.mjs --test tests/api.test.js
// node:test copies --import into each per-file subprocess, and Node runs --import in
// file-based worker threads too (CommonJS eval workers are the exception; see
// scripts/test-postgres.mjs). Top-level await: the pool is warm before any test
// module is loaded, so createApp() can open a database synchronously.
import {isMainThread,workerData} from 'node:worker_threads';

const DEFAULT_URL='postgres://wimblo:wimblo-dev@127.0.0.1:57900/wimblo_dev';
const LOOPBACK=new Set(['127.0.0.1','localhost','[::1]','::1']);

// The synchronous driver's own worker is a file worker, so this preload runs inside it
// as well. It must not build a pool there: every handle would recursively spawn more.
const driverWorker=!isMainThread&&workerData&&workerData.control instanceof SharedArrayBuffer&&workerData.payload instanceof SharedArrayBuffer&&typeof workerData.url==='string';

// `node --import … --test` also runs this in the orchestrating runner, which never opens a
// database; node:test marks its per-file children with NODE_TEST_CONTEXT. Skipping the
// runner saves a whole pool of connections per invocation.
const testRunner=isMainThread&&process.execArgv.some(a=>a==='--test'||a.startsWith('--test='))&&!process.env.NODE_TEST_CONTEXT;

if(!driverWorker&&!testRunner){
 const url=process.env.WIMBLO_PG_URL||DEFAULT_URL;
 let parsed;
 try{parsed=new URL(url);}catch{throw new Error('WIMBLO_PG_URL is not a valid URL.');}
 if(!/^postgres(ql)?:$/.test(parsed.protocol)||!LOOPBACK.has(parsed.hostname)||parsed.searchParams.has('host'))throw new Error(`The PostgreSQL test harness only connects to a loopback server; refusing ${parsed.protocol}//${parsed.hostname}. It never targets Neon or any hosted database.`);
 const size=Number(process.env.WIMBLO_PG_POOL_SIZE||(isMainThread?6:2));
 const run=process.env.WIMBLO_PG_RUN||'adhoc';
 if(!/^[a-z0-9]{1,12}$/.test(run))throw new Error('WIMBLO_PG_RUN must be 1-12 lowercase letters or digits.');
 const [{createPostgresPool,openPostgresDatabase,postgresDatabaseExists},{setDatabaseFactory}]=await Promise.all([import('../../../server/persistence/postgresDatabase.js'),import('../../../server/persistence/openDatabase.js')]);
 let pool;
 // WIMBLO_PG_TRACE=1 prints every failed statement. Many are expected (trigger refusals are the product), so read it for SQLSTATEs other than P0001.
 const trace=({schema,source,translated,error})=>{try{process.stderr.write(`[wimblo-pg-error] ${error.code||error.name}: ${error.message}\n  source: ${String(source).replace(/\s+/g,' ').slice(0,600)}\n${translated&&translated!==source?`  translated: ${String(translated).replace(/\s+/g,' ').slice(0,600)}\n`:''}`);}catch{}};
 // A server that is restarting ("in recovery mode", connection refused) gets up to 30 s; anything else fails at once.
 for(let waited=0,delay=250;;waited+=delay,delay=Math.min(delay*2,4000)){
  try{pool=await createPostgresPool({url,size,schemaPrefix:`wt_${run}_`,dropMemorySchemas:false,onError:process.env.WIMBLO_PG_TRACE?trace:null});break;}
  catch(e){
   if(waited<30000&&/recovery mode|starting up|shutting down|ECONNREFUSED|ECONNRESET|terminat/i.test(e.message)){await new Promise(r=>setTimeout(r,delay));continue;}
   throw new Error(`The PostgreSQL test harness could not warm ${size} handles against ${parsed.host}: ${e.message}. Start wimblo-migration-pg and retry.`);
  }
 }
 setDatabaseFactory((path,options)=>openPostgresDatabase(pool,path,options),{exists:path=>postgresDatabaseExists(pool,path)});
 globalThis.__wimbloPostgresHarness={pool,url:`${parsed.protocol}//${parsed.host}${parsed.pathname}`,pid:process.pid,mainThread:isMainThread};
 if(process.env.WIMBLO_PG_STATS)process.once('exit',()=>{try{process.stderr.write(`[wimblo-pg] pid=${process.pid} ${JSON.stringify(pool.stats)}\n`);}catch{}});
}
