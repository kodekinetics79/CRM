#!/usr/bin/env node
// Runs UNMODIFIED test files against the local PostgreSQL container through the
// harness preload, prints pass/fail/skip counts, and drops every schema the run created.
//
//   node scripts/test-postgres.mjs                         # every tests/*.test.js
//   node scripts/test-postgres.mjs tests/api.test.js ...   # chosen files
//   options: --concurrency=N --pool=N --keep (leave schemas) --clean=<run id> (drop one interrupted run's schemas)
//
// Each file runs in its own `node --import preload --test <file>` process, so a file
// crash is contained and counts are per file. node:test's orchestrating runner skips
// the pool (see preload.mjs); the per-file child warms `pool` handles.
//
// Connection budget: every file process holds exactly `pool` connections for its life,
// the script holds one admin connection, and the CommonJS eval workers some integrity
// tests start do not run the preload (so they open none). The run needs
// concurrency*pool+1 client connections; it is checked against max_connections minus
// superuser_reserved_connections minus the client backends already connected, and the
// concurrency is lowered (never the pool) if it does not fit.
import {spawn} from 'node:child_process';
import {readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {availableParallelism,tmpdir} from 'node:os';
import {join,resolve,relative,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import pg from 'pg';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const preload=join(root,'tests/postgres/harness/preload.mjs');
const url=process.env.WIMBLO_PG_URL||'postgres://wimblo:wimblo-dev@127.0.0.1:57900/wimblo_dev';
const LOOPBACK=new Set(['127.0.0.1','localhost','[::1]','::1']);
const host=new URL(url);
if(!LOOPBACK.has(host.hostname)||host.searchParams.has('host')){console.error(`Refusing ${host.hostname}: the PostgreSQL test harness only targets a loopback server, never Neon or a hosted database.`);process.exit(2);}

const args=process.argv.slice(2),flag=name=>args.find(a=>a===`--${name}`||a.startsWith(`--${name}=`));
const value=(name,fallback)=>{const f=flag(name);return f&&f.includes('=')?Number(f.split('=')[1]):fallback;};
const POOL=value('pool',8),keep=Boolean(flag('keep')),cleanOnly=Boolean(flag('clean'));
let concurrency=value('concurrency',Math.min(8,Math.max(1,availableParallelism()-2)));
if(!Number.isSafeInteger(POOL)||POOL<1||!Number.isSafeInteger(concurrency)||concurrency<1){console.error('--pool and --concurrency must be positive integers.');process.exit(2);}
const files=args.filter(a=>!a.startsWith('--')).map(f=>resolve(f));
const targets=files.length?files:readdirSync(join(root,'tests')).filter(f=>f.endsWith('.test.js')).sort().map(f=>join(root,'tests',f));

let admin=new pg.Client({connectionString:url,application_name:'wimblo-test-postgres'});
// A server restart during a long run must not crash the runner before it reports and cleans up.
admin.on('error',e=>{console.error(`Admin connection lost (${e.message}); it will reconnect for cleanup.`);});
await admin.connect().catch(e=>{console.error(`Cannot reach the local PostgreSQL container at ${host.host}: ${e.message}`);process.exit(2);});
async function dropSchemas(pattern){
 try{await admin.query('SELECT 1');}catch{admin=new pg.Client({connectionString:url,application_name:'wimblo-test-postgres'});admin.on('error',()=>{});await admin.connect();}
 const {rows}=await admin.query(String.raw`SELECT nspname FROM pg_namespace WHERE nspname LIKE $1 ESCAPE '\' ORDER BY 1`,[pattern]);
 for(const {nspname} of rows)await admin.query(`DROP SCHEMA IF EXISTS "${nspname.replaceAll('"','""')}" CASCADE`);
 return rows.length;
}
// Clean-up is always scoped to ONE run id (`wt_<run>_*`), so two runs can never destroy each other's schemas. A run
// drops its own schemas when it ends; --clean=<run> is only for a run that was interrupted before it could.
if(cleanOnly){
 const target=(flag('clean').split('=')[1]||'').trim();
 if(!/^[a-z0-9]{1,12}$/.test(target)){console.error('--clean needs the run id printed at the start of that run, e.g. --clean=2c67b79866. There is no clean-all.');await admin.end();process.exit(2);}
 const n=await dropSchemas(String.raw`wt\_${target}\_%`);console.log(`Dropped ${n} schema(s) of run ${target}.`);await admin.end();process.exit(0);
}

const q=async sql=>(await admin.query(sql)).rows[0];
const max=Number((await q('SHOW max_connections')).max_connections),reserved=Number((await q('SHOW superuser_reserved_connections')).superuser_reserved_connections);
const inUse=Number((await q("SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type='client backend'")).n);
const available=max-reserved-inUse;
const fit=Math.floor(available/POOL);
if(fit<1){console.error(`Only ${available} connection(s) available (max_connections ${max}, ${reserved} reserved, ${inUse} in use); a pool of ${POOL} does not fit.`);await admin.end();process.exit(2);}
if(concurrency>fit){console.log(`Lowering concurrency ${concurrency} -> ${fit} to fit ${available} available connections at pool ${POOL}.`);concurrency=fit;}
concurrency=Math.min(concurrency,targets.length);

const run=randomBytes(5).toString('hex'),logs=join(tmpdir(),`wimblo-pg-${run}`);
mkdirSync(logs,{recursive:true});
console.log(`PostgreSQL test run ${run}: ${targets.length} file(s), concurrency ${concurrency}, pool ${POOL} -> at most ${concurrency*POOL+1} of ${available} available connections (max_connections ${max}). Logs: ${logs}`);

// Memoised: a signal and the normal end of the run share ONE sweep and both see its real count.
let sweep=null;
const cleanup=()=>keep?Promise.resolve(0):sweep??=dropSchemas(String.raw`wt\_${run}\_%`);
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{console.log('\nInterrupted; dropping this run\'s schemas.');try{await cleanup();}finally{process.exit(130);}});

const count=(text,key)=>{const m=new RegExp(`^ℹ ${key} (\\d+)$`,'m').exec(text);return m?Number(m[1]):null;};
function runFile(file){
 return new Promise(done=>{
  const started=Date.now(),chunks=[];
  const child=spawn(process.execPath,['--import',preload,'--test','--test-reporter=spec',file],{cwd:root,env:{...process.env,WIMBLO_PG_URL:url,WIMBLO_PG_RUN:run,WIMBLO_PG_POOL_SIZE:String(POOL),WIMBLO_PG_STATS:'1',FORCE_COLOR:'0',NO_COLOR:'1'}});
  child.stdout.on('data',c=>chunks.push(c));child.stderr.on('data',c=>chunks.push(c));
  child.on('close',code=>{
   const text=Buffer.concat(chunks).toString('utf8'),name=relative(root,file);
   writeFileSync(join(logs,name.replaceAll('/','__')+'.log'),text);
   const r={name,code,ms:Date.now()-started,tests:count(text,'tests'),pass:count(text,'pass'),fail:count(text,'fail'),skipped:count(text,'skipped'),cancelled:count(text,'cancelled'),todo:count(text,'todo'),peak:Math.max(0,...[...text.matchAll(/\[wimblo-pg\].*"peak":(\d+)/g)].map(m=>Number(m[1])))};
   // A process that died before its summary (for example the preload refusing) counts as one failure, never as nothing.
   if(r.tests===null){r.tests=1;r.pass=0;r.fail=1;r.skipped=r.cancelled=r.todo=0;r.crashed=true;}
   done(r);
  });
 });
}

const results=[],queue=[...targets];
await Promise.all(Array.from({length:concurrency},async()=>{
 while(queue.length){
  const r=await runFile(queue.shift());results.push(r);
  const mark=r.fail||r.cancelled?'FAIL':'ok  ';
  console.log(`${mark} ${r.name.padEnd(58)} pass ${String(r.pass).padStart(3)} fail ${String(r.fail).padStart(3)} skip ${String(r.skipped).padStart(2)}${r.cancelled?` cancelled ${r.cancelled}`:''} peak ${r.peak}/${POOL} ${(r.ms/1000).toFixed(1)}s${r.crashed?' (no summary: process crashed)':''}`);
 }
}));

const sum=key=>results.reduce((n,r)=>n+(r[key]||0),0);
const dropped=await cleanup().catch(e=>{console.error(`Schema cleanup failed: ${e.message}. Run: node scripts/test-postgres.mjs --clean=${run}`);return 0;});
await admin.end().catch(()=>{});
results.sort((a,b)=>a.name.localeCompare(b.name));
writeFileSync(join(logs,'summary.json'),JSON.stringify({run,concurrency,pool:POOL,results},null,1));
console.log(`\nfiles ${results.length} | tests ${sum('tests')} | pass ${sum('pass')} | fail ${sum('fail')} | skipped ${sum('skipped')} | cancelled ${sum('cancelled')} | todo ${sum('todo')} | peak handles per process ${Math.max(0,...results.map(r=>r.peak))}/${POOL}`);
console.log(keep?`Schemas kept (wt_${run}_*). Drop later with: node scripts/test-postgres.mjs --clean=${run}`:`Dropped ${dropped} schema(s) created by run ${run}.`);
process.exitCode=sum('fail')||sum('cancelled')?1:0;
