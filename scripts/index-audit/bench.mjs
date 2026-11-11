#!/usr/bin/env node
// Buyer-scale write-path timing on SQLite. Run once on the code before a change and
// once after, then compare. Timing is noisy; the plans in index-audit.md and the plan
// assertions in tests/gift-source-reference-scale.test.js are the evidence of index use.
//   node scripts/index-audit/bench.mjs <label> [--imports=N] [--creates=N] [--out=file.json]
import {once} from 'node:events';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../server/app.js';
import {populateBuyerScale,BUYER_SCALE} from '../../tests/buyer-scale-fixture.js';

const args=process.argv.slice(2),label=args.find(a=>!a.startsWith('--'))||'run';
const opt=(name,fallback)=>{const f=args.find(a=>a.startsWith(`--${name}=`));return f?f.split('=')[1]:fallback;};
const creates=Number(opt('creates',15)),imports=Number(opt('imports',1)),out=opt('out',null);
const dir=mkdtempSync(join(tmpdir(),'wimblo-bench-'));
const app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true,reminderWorker:false,workflowWorker:false}),db=app.locals.db;
const server=app.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
try{
 let t=performance.now();const ids=populateBuyerScale(db);const populateMs=performance.now()-t;
 const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'alex@foundation.example',password:'FoundationDemo!2026'})});
 const session=await login.json(),cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 const post=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':session.csrfToken},body:JSON.stringify(body)});const json=await r.json();if(r.status!==201)throw new Error(`${path} ${r.status} ${JSON.stringify(json)}`);return json;};
 const pledge=JSON.parse(db.prepare("SELECT data FROM records WHERE collection='pledges' AND id=?").get(ids.pledges[1]).data);
 const gift=(changes={})=>({constituentId:ids.constituents[5],amount:1000,type:'Cash',method:'Check',date:'2026-09-13',campaignId:null,allocations:[{designationId:ids.designations[7],amount:1000}],externalRef:'',notes:'',tribute:'',softCreditId:null,pledge:'',pledgeId:null,grantId:null,giftKind:'One-time',...changes});
 const time=async(n,fn)=>{if(!n)return null;const samples=[];for(let i=0;i<n;i++){const s=performance.now();await fn(i);samples.push(performance.now()-s);}samples.sort((a,b)=>a-b);return {n,medianMs:+samples[Math.floor(n/2)].toFixed(2),minMs:+samples[0].toFixed(2),maxMs:+samples.at(-1).toFixed(2)};};
 await post('/api/records/gifts',gift());// warm statement caches
 const result={label,node:process.version,scale:BUYER_SCALE,populateMs:+populateMs.toFixed(0),giftsBefore:db.prepare("SELECT count(*) n FROM records WHERE collection='gifts'").get().n,
  manualGiftCreate:await time(creates,()=>post('/api/records/gifts',gift())),
  referencedGiftCreate:await time(creates,i=>post('/api/records/gifts',gift({externalRef:`BENCH-${label}-${i}-${randomUUID()}`}))),
  pledgeReceiptCreate:await time(creates,()=>post('/api/records/gifts',gift({constituentId:pledge.constituentId,giftKind:'Pledge fulfillment',pledgeId:pledge.id}))),
  import500:await time(imports,i=>post('/api/gifts/import',{rows:Array.from({length:500},(_,k)=>gift({externalRef:`BENCH-IMPORT-${label}-${i}-${k}`}))}))};
 console.log(JSON.stringify(result,null,1));
 if(out)writeFileSync(out,JSON.stringify(result,null,1));
}finally{await new Promise(r=>server.close(r));app.locals.close();rmSync(dir,{recursive:true,force:true});}
