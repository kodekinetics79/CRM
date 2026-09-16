import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';
import {ACCOUNT_STRUCTURE_QUERIES} from '../server/accountStructure.js';

// Buyer-reported account volume (public Q&A34): about 1,622 designations, with
// one-time classroom funds added and retired every year. These are representative
// synthetic accounts at that reported count, not the buyer's own list and not a
// historical transaction volume claim. The gift sample below is a separately named
// synthetic relationship sample used only to prove allocation arithmetic.
const operator={name:'Synthetic account structure operator',email:'structure.operator@example.test',password:'AccountStructure!2026'};
const LOCATIONS=60,FUNCTIONS=12,FUNCTIONS_PER_LOCATION=3,DESIGNATIONS=1622,LINKED=900,GIFTS=600;
const pad=(n,w)=>String(n).padStart(w,'0');

function plan(){
 const locations=Array.from({length:LOCATIONS},(_,i)=>({index:i,code:pad(100+i,3),name:'Synthetic location '+i}));
 const functions=Array.from({length:FUNCTIONS},(_,j)=>({index:j,code:pad(4000+j,4),name:'Synthetic function '+j}));
 const pairs=[];for(const location of locations)for(let n=0;n<FUNCTIONS_PER_LOCATION;n++){const fn=functions[(location.index+n)%FUNCTIONS];pairs.push({code:location.code+'-'+fn.code,location,fn});}
 const roots=Array.from({length:LOCATIONS},(_,i)=>({key:'root-'+i,name:'Synthetic location fund '+i,accountCode:'ORIG-L'+pad(i,3),parentKey:null,school:'Synthetic location '+i}));
 const children=Array.from({length:DESIGNATIONS-LOCATIONS},(_,k)=>({key:'child-'+k,name:'Synthetic classroom fund '+k,accountCode:'ORIG-C'+pad(k,4),parentKey:'root-'+(k%LOCATIONS),school:'Synthetic location '+(k%LOCATIONS)}));
 const designations=[...roots,...children];
 // Subaccounts of one school fund deliberately land on accounts in DIFFERENT
 // locations, and every function is shared by many locations.
 const links=[];for(let i=0;i<LOCATIONS;i++)links.push({key:'root-'+i,pairCode:pairs[i*FUNCTIONS_PER_LOCATION].code});
 for(let k=0;links.length<LINKED;k++)links.push({key:'child-'+k,pairCode:pairs[(k*7)%pairs.length].code});
 return {locations,functions,pairs,roots,children,designations,links};
}
function giftPlan(designations){
 const children=designations.filter(d=>d.key.startsWith('child-')),roots=designations.filter(d=>d.key.startsWith('root-'));
 return Array.from({length:GIFTS},(_,g)=>{
  const picks=[children[(g*7)%children.length],children[(g*13+5)%children.length],roots[g%roots.length]];
  const unique=[...new Map(picks.map(d=>[d.key,d])).values()];
  const allocations=unique.map((d,i)=>({key:d.key,amount:[1000+g,2000+3*g,700+g][i]}));
  return {allocations,amount:allocations.reduce((n,a)=>n+a.amount,0)};
 });
}

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-account-structure-scale-')),dbPath=join(dir,'workspace.sqlite');let app,server,base,session;
 async function open(){app=createApp({dbPath,seed:false,initialAdmin:operator,mfaKey:'',reminderWorker:false,workflowWorker:false});server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;session=await login();}
 async function close(){if(server)await new Promise(r=>server.close(r));server=null;app?.locals.close();app=null;}
 async function login(email=operator.email){const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:operator.password})});assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.get('set-cookie').split(';')[0]};}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,as}={}){const use=as||session;const r=await fetch(base+'/api'+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),Cookie:use.cookie,'X-CSRF-Token':use.csrfToken},...(body!==undefined?{body:JSON.stringify(body)}:{})});const text=await r.text();let json;try{json=JSON.parse(text);}catch{}return {status:r.status,json,text};}
 return {request,login,get db(){return app.locals.db;},restart:async()=>{await close();await open();}};
}
const ok=(r,expected=201)=>{assert.equal(r.status,expected,r.text);return r.json;};

test('about 1,622 representative designations across many locations stay exact, filterable and indexed with no double posting',async t=>{
 const started=Date.now(),f=await fixture(t),model=plan(),gifts=giftPlan(model.designations);

 const locationRows=new Map(),functionRows=new Map(),pairRows=new Map();
 for(const location of model.locations)locationRows.set(location.code,ok(await f.request('/account-structure/locations',{method:'POST',body:{code:location.code,name:location.name}})).location);
 for(const fn of model.functions)functionRows.set(fn.code,ok(await f.request('/account-structure/functions',{method:'POST',body:{code:fn.code,name:fn.name}})).function);
 for(const pair of model.pairs){const l=locationRows.get(pair.location.code),x=functionRows.get(pair.fn.code);pairRows.set(pair.code,ok(await f.request('/account-structure/pairs',{method:'POST',body:{locationId:l.id,locationVersion:l.version,functionId:x.id,functionVersion:x.version}})).pair);}
 assert.equal(pairRows.size,LOCATIONS*FUNCTIONS_PER_LOCATION);
 assert.equal(new Set([...pairRows.values()].map(p=>p.code)).size,pairRows.size,'every location and function pair is one unique account');
 for(const fn of model.functions)assert.equal(ok(await f.request('/account-structure/pairs?limit=500&functionId='+functionRows.get(fn.code).id),200).matched,LOCATIONS*FUNCTIONS_PER_LOCATION/FUNCTIONS,'each function spans many locations');
 const structureMs=Date.now()-started,designationsStarted=Date.now();

 const records=new Map();
 for(const d of model.designations)records.set(d.key,ok(await f.request('/records/designations',{method:'POST',body:{name:d.name,school:d.school,accountCode:d.accountCode,parentId:d.parentKey?records.get(d.parentKey).id:null,description:''}})).record);
 assert.equal(records.size,DESIGNATIONS);
 const designationMs=Date.now()-designationsStarted,giftsStarted=Date.now();

 const donor=ok(await f.request('/records/constituents',{method:'POST',body:{name:'Synthetic account structure donor',email:'structure.donor@example.test',type:'Individual'}})).record;
 for(let start=0;start<gifts.length;start+=250){
  const rows=gifts.slice(start,start+250).map(gift=>({constituentId:donor.id,amount:gift.amount,type:'Cash',method:'Check',date:'2026-09-14',allocations:gift.allocations.map(a=>({designationId:records.get(a.key).id,amount:a.amount}))}));
  assert.equal(ok(await f.request('/gifts/import',{method:'POST',body:{rows}})).imported,rows.length);
 }
 const giftMs=Date.now()-giftsStarted,linkStarted=Date.now();

 const linkedKeys=new Set();
 for(const link of model.links){const record=records.get(link.key),pair=pairRows.get(link.pairCode);ok(await f.request('/account-structure/designations/'+record.id+'/link',{method:'POST',body:{designationVersion:record.version,pairId:pair.id,pairVersion:pair.version,reason:'Representative account assignment'}}));linkedKeys.add(link.key);}
 assert.equal(linkedKeys.size,LINKED);
 const linkMs=Date.now()-linkStarted;

 // Independent expectation built from the plan, never from the API response.
 const directByKey=new Map();for(const gift of gifts)for(const a of gift.allocations)directByKey.set(a.key,(directByKey.get(a.key)||0)+a.amount);
 const pairOf=new Map(model.links.map(l=>[l.key,l.pairCode]));
 const expectedPair=new Map(),expectedLocation=new Map(),expectedFunction=new Map();
 let expectedLinked=0,expectedUnlinked=0;
 for(const [key,cents] of directByKey){
  const pairCode=pairOf.get(key);
  if(!pairCode){expectedUnlinked+=cents;continue;}
  expectedLinked+=cents;
  const [locationCode,functionCode]=pairCode.split('-');
  expectedPair.set(pairCode,(expectedPair.get(pairCode)||0)+cents);
  expectedLocation.set(locationCode,(expectedLocation.get(locationCode)||0)+cents);
  expectedFunction.set(functionCode,(expectedFunction.get(functionCode)||0)+cents);
 }
 const expectedTotal=gifts.reduce((n,g)=>n+g.amount,0);
 assert.equal(expectedLinked+expectedUnlinked,expectedTotal);

 const queried=Date.now();
 const byPair=ok(await f.request('/account-structure/rollups?groupBy=pair'),200),byLocation=ok(await f.request('/account-structure/rollups?groupBy=location'),200),byFunction=ok(await f.request('/account-structure/rollups?groupBy=function'),200);
 const rollupMs=Date.now()-queried;

 for(const rollup of [byPair,byLocation,byFunction]){
  assert.equal(rollup.reconciliation.reconciled,true,JSON.stringify(rollup.reconciliation));
  assert.equal(rollup.reconciliation.duplicatedCents,0);
  assert.equal(rollup.totals.postedGiftCents,expectedTotal);
  assert.equal(rollup.totals.allocationCents,expectedTotal);
  assert.equal(rollup.totals.linkedCents,expectedLinked);
  assert.equal(rollup.totals.unlinkedCents,expectedUnlinked);
  assert.equal(rollup.groups.reduce((n,g)=>n+g.cents,0),expectedLinked);
 }
 assert.deepEqual(Object.fromEntries(byPair.groups.map(g=>[g.code,g.cents])),Object.fromEntries(expectedPair));
 assert.deepEqual(Object.fromEntries(byLocation.groups.map(g=>[g.code,g.cents])),Object.fromEntries(expectedLocation));
 assert.deepEqual(Object.fromEntries(byFunction.groups.map(g=>[g.code,g.cents])),Object.fromEntries(expectedFunction));
 // A function shared by fifteen locations still totals its allocations exactly once.
 for(const group of byFunction.groups){assert.equal(group.locationCount,LOCATIONS*FUNCTIONS_PER_LOCATION/FUNCTIONS);assert.equal(group.cents,byPair.groups.filter(p=>p.functionCode===group.code).reduce((n,p)=>n+p.cents,0));}
 assert.equal(byFunction.groups.reduce((n,g)=>n+g.allocations,0),byPair.groups.reduce((n,g)=>n+g.allocations,0));

 // Filters stay accurate at volume, against the same independent expectation.
 const filterStarted=Date.now();
 const sampleLocation=model.locations[17],sampleFunction=model.functions[5];
 const linkedAtLocation=model.links.filter(l=>l.pairCode.startsWith(sampleLocation.code+'-')).map(l=>l.key);
 const locationPage=ok(await f.request('/account-structure/designations?limit=500&locationId='+locationRows.get(sampleLocation.code).id),200);
 assert.equal(locationPage.matched,linkedAtLocation.length);
 assert.deepEqual(locationPage.designations.map(d=>d.accountCode).sort(),linkedAtLocation.map(key=>model.designations.find(d=>d.key===key).accountCode).sort());
 assert.equal(locationPage.matchedTotals.directCents,linkedAtLocation.reduce((n,key)=>n+(directByKey.get(key)||0),0));
 const linkedAtFunction=model.links.filter(l=>l.pairCode.endsWith('-'+sampleFunction.code)).map(l=>l.key);
 const functionPage=ok(await f.request('/account-structure/designations?limit=500&functionId='+functionRows.get(sampleFunction.code).id),200);
 assert.equal(functionPage.matched,linkedAtFunction.length);
 assert.equal(functionPage.matchedTotals.directCents,linkedAtFunction.reduce((n,key)=>n+(directByKey.get(key)||0),0));
 assert.ok(new Set(functionPage.designations.map(d=>d.account.locationCode)).size>1,'one function serves subaccounts in several locations');
 const unlinkedPage=ok(await f.request('/account-structure/designations?limit=500&link=Unlinked'),200);
 assert.equal(unlinkedPage.matched,DESIGNATIONS-LINKED);
 assert.equal(unlinkedPage.matchedTotals.directCents,expectedUnlinked);
 const everything=ok(await f.request('/account-structure/designations?limit=500'),200);
 assert.equal(everything.total,DESIGNATIONS);assert.equal(everything.matched,DESIGNATIONS);assert.equal(everything.returned,500);
 assert.equal(everything.hierarchy.roots,LOCATIONS);assert.equal(everything.hierarchy.maxDepth,1);assert.equal(everything.hierarchy.cycles,0);
 assert.equal(everything.hierarchy.rootSubtreeCents,expectedTotal,'the whole parent/child tree rolls up to the ledger exactly once');
 const searched=ok(await f.request('/account-structure/designations?limit=500&search=ORIG-C000'),200);
 assert.equal(searched.matched,10);
 const filterMs=Date.now()-filterStarted;

 // Every acquisition must stay on an index rather than scanning the structure.
 const explain=sql=>f.db.prepare('EXPLAIN QUERY PLAN '+sql).all().map(r=>r.detail);
 const steps=(lines,pattern)=>lines.filter(line=>pattern.test(line));
 // A json_each expansion of one gift's own allocations is the only permitted scan;
 // no structure table may be scanned, at any rollup grouping.
 for(const key of ['byPair','byLocation','byFunction','totals']){
  const lines=explain(ACCOUNT_STRUCTURE_QUERIES[key]),shown=key+': '+lines.join(' | ');
  assert.equal(steps(lines,/^SEARCH .*account_designation_links/).length,1,shown);
  assert.equal(steps(lines,/^SCAN/).filter(line=>!/VIRTUAL TABLE/.test(line)).length,0,shown);
  assert.equal(steps(lines,/^SEARCH g USING .*INDEX.*\(collection=\?\)/).length,1,shown);
 }
 for(const key of ['byLocation','byFunction'])assert.equal(steps(explain(ACCOUNT_STRUCTURE_QUERIES[key]),/^SEARCH p USING (INTEGER )?PRIMARY KEY|^SEARCH .*account_pairs/).length,1,key);
 assert.equal(steps(explain(ACCOUNT_STRUCTURE_QUERIES.pairsByFunction),/USING INDEX account_pair_function/).length,1);
 assert.equal(steps(explain(ACCOUNT_STRUCTURE_QUERIES.linksByPair),/USING (COVERING )?INDEX account_link_pair/).length,1);
 assert.equal(steps(explain(ACCOUNT_STRUCTURE_QUERIES.designationRecords),/^SEARCH records USING .*\(collection=\?\)/).length,1);
 for(const key of ['allocationIntegrity','giftReconciliation','postedGifts'])assert.equal(steps(explain(ACCOUNT_STRUCTURE_QUERIES[key]),/^SCAN/).filter(line=>!/VIRTUAL TABLE/.test(line)).length,0,key);

 // Retirement at volume retains everything and never orphans a posted allocation.
 const retiring=locationRows.get(sampleLocation.code);
 ok(await f.request('/account-structure/locations/'+retiring.id+'/status',{method:'POST',body:{version:retiring.version,status:'Retired',reason:'Representative annual retirement of a closed classroom location'}}),200);
 const retired=ok(await f.request('/account-structure/rollups?groupBy=pair'),200);
 assert.equal(retired.reconciliation.reconciled,true);
 assert.deepEqual(Object.fromEntries(retired.groups.map(g=>[g.code,g.cents])),Object.fromEntries(expectedPair));
 assert.equal(retired.totals.linkedCents,expectedLinked);

 await f.restart();
 const persisted=ok(await f.request('/account-structure/rollups?groupBy=pair'),200);
 assert.equal(persisted.reconciliation.reconciled,true);
 assert.deepEqual(Object.fromEntries(persisted.groups.map(g=>[g.code,g.cents])),Object.fromEntries(expectedPair));
 assert.equal(ok(await f.request('/account-structure'),200).counts.linkedDesignations,LINKED);

 const counts={locations:LOCATIONS,functions:FUNCTIONS,accounts:pairRows.size,designations:DESIGNATIONS,linkedDesignations:LINKED,unlinkedDesignations:DESIGNATIONS-LINKED,gifts:GIFTS,allocations:gifts.reduce((n,g)=>n+g.allocations.length,0),postedCents:expectedTotal};
 t.diagnostic('records '+JSON.stringify(counts));
 t.diagnostic('milliseconds '+JSON.stringify({structure:structureMs,designations:designationMs,gifts:giftMs,links:linkMs,rollups:rollupMs,filters:filterMs,total:Date.now()-started}));
 assert.ok(rollupMs<5000,'three complete rollups over the representative account list must stay well under five seconds: '+rollupMs+'ms');
 assert.ok(filterMs<5000,'filtered designation acquisition must stay well under five seconds: '+filterMs+'ms');
});
