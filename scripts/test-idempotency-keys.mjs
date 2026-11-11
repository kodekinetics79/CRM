#!/usr/bin/env node
// A6: prove the path production runs. The browser sends an Idempotency-Key on every mutating request; existing
// tests send none. This runs chosen test files twice — once unmodified, once with a unique key injected into every
// mutating fetch() — and fails unless both runs pass exactly the same tests.
//
//   node scripts/test-idempotency-keys.mjs                         # the five route-heavy files below
//   node scripts/test-idempotency-keys.mjs tests/api.test.js ...   # chosen files
//   node scripts/test-idempotency-keys.mjs --all                   # every tests/*.test.js
//   options: --keyed-only (skip the unkeyed baseline)
//
// The same file is the preload: `node --test --import <this file>` with WIMBLO_IDEMPOTENCY_KEYS_PRELOAD=1 wraps
// globalThis.fetch. Nothing is assumed about execArgv reaching node:test's per-file subprocesses: every process that
// loads the preload writes a proof record naming its test file and how many keys it injected, the server middleware
// writes a trace record for every keyed request it handled (WIMBLO_IDEMPOTENCY_TRACE), and the run fails if any target
// file shows no preload, or if keys were injected but the server saw none.
import {spawn} from 'node:child_process';
import {appendFileSync,readFileSync,readdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

const self=fileURLToPath(import.meta.url),MUTATING=new Set(['POST','PUT','PATCH','DELETE']);

if(process.env.WIMBLO_IDEMPOTENCY_KEYS_PRELOAD==='1'){
 const proof=process.env.WIMBLO_IDEMPOTENCY_KEYS_PROOF,file=process.argv[1]||null,original=globalThis.fetch;let injected=0,supplied=0;
 const record=entry=>{try{appendFileSync(proof,JSON.stringify({pid:process.pid,file,...entry})+'\n');}catch{}};
 globalThis.fetch=function(input,init){
  const method=String(init?.method||(typeof Request!=='undefined'&&input instanceof Request?input.method:'GET')).toUpperCase();
  if(MUTATING.has(method)){const headers=new Headers(init?.headers||(input instanceof Request?input.headers:undefined));if(headers.has('Idempotency-Key'))supplied++;else{headers.set('Idempotency-Key',randomUUID());injected++;init={...(init||{}),headers};}}
  return original.call(this,input,init);
 };
 record({event:'loaded'});process.on('exit',()=>record({event:'exit',injected,supplied}));
}else if(process.argv[1]&&resolve(process.argv[1])===self){
 const root=resolve(dirname(self),'..'),args=process.argv.slice(2);
 const DEFAULT=['tests/api.test.js','tests/receipts.test.js','tests/fundraising.test.js','tests/identity.test.js','tests/tenant-administration.test.js'];
 const chosen=args.filter(a=>!a.startsWith('--'));
 const targets=(args.includes('--all')?readdirSync(join(root,'tests')).filter(f=>f.endsWith('.test.js')).sort().map(f=>'tests/'+f):chosen.length?chosen:DEFAULT).map(f=>resolve(root,f));
 for(const f of targets)if(!existsSync(f)){console.error('Missing test file '+f);process.exit(2);}
 const work=mkdtempSync(join(tmpdir(),'wimblo-idempotency-keys-'));
 const readLines=path=>existsSync(path)?readFileSync(path,'utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];

 function run(mode){
  const proof=join(work,mode+'-proof.jsonl'),trace=join(work,mode+'-trace.jsonl');
  const env={...process.env,WIMBLO_IDEMPOTENCY_TRACE:trace};delete env.WIMBLO_IDEMPOTENCY_KEYS_PRELOAD;
  const argv=['--test','--test-reporter=tap'];
  if(mode==='keyed'){argv.push('--import',pathToFileURL(self).href);Object.assign(env,{WIMBLO_IDEMPOTENCY_KEYS_PRELOAD:'1',WIMBLO_IDEMPOTENCY_KEYS_PROOF:proof});}
  argv.push(...targets);
  return new Promise(done=>{
   const child=spawn(process.execPath,argv,{cwd:root,env,stdio:['ignore','pipe','pipe']});let out='';
   child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>out+=d);
   child.on('close',code=>{
    const results=new Map(),seen=new Map();let summary={};
    for(const line of out.split('\n')){
     const m=/^(\s*)(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO).*)?$/.exec(line);
     if(m){const id=m[1].length+':'+m[3],n=(seen.get(id)||0)+1;seen.set(id,n);results.set(id+'#'+n,m[4]?m[4].toLowerCase():m[2]==='ok'?'pass':'fail');continue;}
     const s=/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);if(s)summary[s[1]]=Number(s[2]);
    }
    done({mode,code,out,results,summary,proof:readLines(proof),trace:readLines(trace)});
   });
  });
 }

 const started=Date.now();
 const baseline=args.includes('--keyed-only')?null:await run('unkeyed');
 const keyed=await run('keyed');
 const problems=[];
 const show=r=>`${r.mode}: tests ${r.summary.tests??'?'} · pass ${r.summary.pass??'?'} · fail ${r.summary.fail??'?'} · cancelled ${r.summary.cancelled??0} · skipped ${r.summary.skipped??0} (exit ${r.code})`;

 // Preload reach, per target file, measured rather than assumed.
 const loaded=new Map(),exits=new Map();
 for(const e of keyed.proof){const file=e.file&&resolve(e.file);if(e.event==='loaded')loaded.set(file,(loaded.get(file)||0)+1);if(e.event==='exit'){const x=exits.get(file)||{injected:0,supplied:0};x.injected+=e.injected;x.supplied+=e.supplied;exits.set(file,x);}}
 console.log('\nPreload reach (keyed run):');
 for(const f of targets){const x=exits.get(f)||{injected:0,supplied:0};console.log(`  ${relative(root,f)}: preload loaded in ${loaded.get(f)||0} process(es), ${x.injected} key(s) injected, ${x.supplied} request(s) already keyed`);if(!loaded.get(f))problems.push(`Preload never loaded in the process running ${relative(root,f)}`);else if(!x.injected)problems.push(`No keys were injected while running ${relative(root,f)}`);}
 const other=keyed.proof.filter(e=>e.event==='loaded'&&!targets.includes(e.file&&resolve(e.file)));
 if(other.length)console.log(`  other processes that loaded the preload: ${other.length} (${[...new Set(other.map(e=>e.file||'no script'))].map(f=>relative(root,f)||f).join(', ')})`);

 // Server-side evidence that injected keys reached the idempotency middleware.
 const outcomes=keyed.trace.reduce((m,e)=>(m[e.outcome]=(m[e.outcome]||0)+1,m),{});
 const injected=[...exits.values()].reduce((n,x)=>n+x.injected,0);
 console.log(`\nServer idempotency trace (keyed run): ${keyed.trace.length} keyed request(s) handled by the middleware of ${injected} injected; outcomes ${JSON.stringify(outcomes)}`);
 console.log('  (Injected keys on routes mounted before the middleware — login, MFA, logout, public and webhook routes — and requests refused before reservation produce no trace.)');
 if(injected&&!keyed.trace.length)problems.push('Keys were injected but the server middleware traced none of them');
 if(baseline?.trace.length)problems.push(`The unkeyed baseline produced ${baseline.trace.length} keyed trace record(s); it was not a genuine unkeyed run`);
 const unmarked=new Map();for(const e of keyed.trace)if(e.outcome==='stored'&&e.status<400&&!e.marked){const k=e.method+' '+e.route;unmarked.set(k,(unmarked.get(k)||0)+1);}
 console.log(`\nSuccessful keyed requests that completed WITHOUT an in-transaction commit marker (A1 gap: marker known only after the handler returned): ${unmarked.size} route(s)`);
 for(const [k,n]of [...unmarked].sort())console.log(`  ${k}  ×${n}`);

 console.log('\nResults:');if(baseline)console.log('  '+show(baseline));console.log('  '+show(keyed));
 if(baseline){
  const diffs=[];for(const [id,status]of baseline.results){const other=keyed.results.get(id);if(other!==status)diffs.push(`${id.replace(/^\d+:/,'')}: unkeyed ${status}, keyed ${other??'missing'}`);}
  for(const id of keyed.results.keys())if(!baseline.results.has(id))diffs.push(`${id.replace(/^\d+:/,'')}: only in keyed run`);
  if(diffs.length){problems.push(`${diffs.length} test outcome(s) differ between unkeyed and keyed runs`);for(const d of diffs.slice(0,50))console.log('  DIFF '+d);}
  else console.log(`  Identical outcomes for all ${baseline.results.size} reported tests and subtests.`);
 }
 if(!keyed.results.size)problems.push('The keyed run reported no tests');
 console.log(`\nDuration ${Math.round((Date.now()-started)/1000)} s.`);
 if(problems.length){console.log('\nFAILED:\n  '+problems.join('\n  '));const failing=keyed.out.split('\n').filter(l=>/^\s*not ok /.test(l));if(failing.length)console.log('Keyed failures:\n'+failing.slice(0,30).join('\n'));console.log(`Raw artifacts kept in ${work}`);process.exit(1);}
 rmSync(work,{recursive:true,force:true});
 console.log('\nPASSED: keyed behaviour equals unkeyed behaviour for the chosen files.');
}
