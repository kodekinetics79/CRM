import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHmac} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {createApp} from '../server/app.js';

const password='SyntheticRecurringIntegrity!2026',adjustmentSecret='synthetic-integrity-adjustment-secret',donorTokenSecret='synthetic-integrity-donor-secret';
const iso=ms=>new Date(ms).toISOString().slice(0,10);
const canonical=v=>v&&typeof v==='object'?Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const sign=payload=>createHmac('sha256',adjustmentSecret).update(canonical(payload)).digest('hex');

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-recurring-integrity-')),dbPath=join(dir,'workspace.sqlite'),tenantId=randomUUID();
 const initialAdmin={name:'Synthetic recurring administrator',email:'recurring.integrity@example.test',password};
 const sessions={},calls=[];let app,server,base,active=true,nowMs=Date.parse('2026-09-15T12:00:00Z'),outcome=null;
 const clock=()=>nowMs;
 const adapter={async collect(request){calls.push(structuredClone(request));if(outcome)return typeof outcome==='function'?outcome(request):structuredClone(outcome);
  return {outcome:'succeeded',providerRef:'rc_test_'+randomUUID().replaceAll('-',''),amountCents:request.amountCents,currency:'usd',method:'ACH',collectedAt:new Date(nowMs).toISOString(),mode:'TEST_ONLY'};}};
 const extensionOptions=()=>({recurringGiving:{mode:'TEST_ONLY',adapter,adjustmentSecret,donorTokenSecret,clock},publicGiving:{mode:'TEST_ONLY',tokenSecret:donorTokenSecret,allowedOrigins:['http://127.0.0.1:5173'],clock}});
 async function close(){if(server)await new Promise(r=>server.close(r));server=null;app?.locals.close();app=null;}
 async function request(path,{method='GET',body,session=sessions.admin,csrf=true,headers={}}={}){
  const r=await fetch(base+'/api'+path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(session?{Cookie:session.cookie,...(csrf?{'X-CSRF-Token':session.csrfToken}:{})}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await r.text();let json;try{json=JSON.parse(text);}catch{json=null;}return {status:r.status,json,text,headers:r.headers};
 }
 async function login(email=initialAdmin.email){const r=await request('/auth/login',{method:'POST',session:null,body:{email,password}});assert.equal(r.status,200,r.text);return {...r.json,cookie:r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')};}
 async function open(path=dbPath){app=createApp({dbPath:path,seed:false,tenantId,initialAdmin,isTenantActive:()=>active,workflowWorker:false,reminderWorker:false,extensions:extensionOptions()});server=app.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;sessions.admin=await login();}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function create(collection,fields){const r=await request('/records/'+collection,{method:'POST',body:fields});assert.equal(r.status,201,r.text);return r.json.record;}
 const donor=await create('constituents',{name:'Actual integrity supporter',type:'Individual',preference:'Do not contact'});
 const campaign=await create('campaigns',{name:'Synthetic integrity giving',type:'Annual',goal:999999,startDate:'2026-01-01',endDate:'2027-12-31',status:'Active'});
 const fund=await create('designations',{name:'Actual integrity fund',accountCode:'RECURRING-INT'});
 const row=(collection,id)=>JSON.parse(app.locals.db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get(collection,id).data);
 const tables=()=>app.locals.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND (name LIKE 'recurring_%' OR name LIKE 'public_giving_%') ORDER BY name").all().map(x=>x.name);
 const snapshot=()=>Object.fromEntries(['records',...tables()].map(n=>[n,app.locals.db.prepare('SELECT * FROM '+n+' ORDER BY rowid').all()]));
 const financial=()=>app.locals.db.prepare("SELECT * FROM records WHERE collection IN ('gifts','pledges','campaigns') ORDER BY rowid").all();
 const gifts=()=>app.locals.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='gifts'").get().n;
 const payload=(changes={})=>({requestId:randomUUID(),kind:'RecurringPayment',donorId:donor.id,donorVersion:row('constituents',donor.id).version,campaignId:campaign.id,campaignVersion:row('campaigns',campaign.id).version,designationId:fund.id,designationVersion:row('designations',fund.id).version,amountCents:10001,currency:'usd',frequency:'Monthly',startDate:iso(nowMs),occurrences:6,reason:'Reviewed synthetic integrity commitment',reviewConfirmed:true,...changes});
 async function intention(changes={}){const r=await request('/recurring-giving/intentions',{method:'POST',body:payload(changes)});assert.equal(r.status,201,r.text);return r.json.intention;}
 async function detail(id){const r=await request('/recurring-giving/intentions/'+id);assert.equal(r.status,200,r.text);return r.json.intention;}
 async function collect(c,changes={}){return request('/recurring-giving/collections/'+c.id+'/collect',{method:'POST',body:{version:c.version,reason:'Reviewed simulated collection',testModeConfirmed:true,...changes}});}
 async function settle(c,changes={},options={}){return request('/recurring-giving/collections/'+c.id+'/record-gift',{method:'POST',body:{version:c.version,donorVersion:row('constituents',donor.id).version,campaignVersion:row('campaigns',campaign.id).version,designationVersion:row('designations',fund.id).version,reason:'Explicit reviewed settlement',reviewConfirmed:true,...changes},...options});}
 async function collected(changes={}){const i=await intention(changes),r=await collect(i.collections[0]);assert.equal(r.status,200,r.text);return {intention:i,collection:r.json.collection};}
 return {dir,dbPath,tenantId,initialAdmin,sessions,request,login,open,close,create,donor,campaign,fund,row,tables,snapshot,financial,gifts,payload,intention,detail,collect,settle,collected,calls,adapter,adjustmentSecret,
  get db(){return app.locals.db;},get app(){return app;},get base(){return base;},get now(){return nowMs;},advanceDays(d){nowMs+=d*86400000;},
  set active(v){active=v;},set outcome(v){outcome=v;},restart:async()=>{await close();await open();}};
}

test('the recurring module contains no provider client and performs no network import in TEST_ONLY mode',async()=>{
 const source=await readFile(new URL('../server/recurringGiving.js',import.meta.url),'utf8');
 for(const forbidden of [/from ['"]stripe['"]/,/require\(['"]stripe['"]\)/,/from ['"]node:https?['"]/,/\bfetch\s*\(/,/new XMLHttpRequest/,/node:net/])
  assert.equal(forbidden.test(source),false,'recurringGiving.js must not reach a provider directly: '+forbidden);
 const publicSource=await readFile(new URL('../server/publicGiving.js',import.meta.url),'utf8');
 for(const forbidden of [/from ['"]stripe['"]/,/from ['"]node:https?['"]/,/\bfetch\s*\(/])
  assert.equal(forbidden.test(publicSource),false,'publicGiving.js must not reach a provider directly: '+forbidden);
});

test('restart preserves schedule, evidence and once-only settlement across a real file-backed workspace',async t=>{
 const f=await fixture(t);
 const {intention:i,collection}=await f.collected();
 const before=f.snapshot();
 await f.restart();
 assert.deepEqual(f.snapshot(),before,'a restart changes no retained recurring row');
 assert.deepEqual(f.tables().filter(n=>n.startsWith('recurring_')),['recurring_adjustments','recurring_collections','recurring_gift_links','recurring_history','recurring_intentions']);
 const live=await f.detail(i.id);
 assert.equal(live.collections[0].status,'Collected');
 assert.equal(live.recordedCashCents,0,'a restart never invents income');
 const posted=await f.settle(live.collections[0]);
 assert.equal(posted.status,201,posted.text);
 assert.equal(f.gifts(),1);
 const financial=f.financial();
 await f.restart();
 assert.deepEqual(f.financial(),financial,'settled income survives restart unchanged');
 const again=await f.settle((await f.detail(i.id)).collections[0]);
 assert.ok([200,201,409].includes(again.status),again.text);
 assert.equal(f.gifts(),1,'a restart never permits a second gift for one collection');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recurring_gift_links').get().n,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='record_recurring_gift'").get().n,1);
});

test('a stale collection version or changed source authority at settlement records no income',async t=>{
 const f=await fixture(t);
 const stale=await f.collected();
 const before=f.snapshot();
 assert.equal((await f.settle(stale.collection,{version:stale.collection.version+7})).status,409);
 assert.deepEqual(f.snapshot(),before);
 for(const change of [{donorVersion:99},{campaignVersion:99},{designationVersion:99},{reviewConfirmed:false}]){
  const r=await f.settle(stale.collection,change);
  assert.ok([400,409].includes(r.status),JSON.stringify(change)+' '+r.text);
  assert.deepEqual(f.snapshot(),before);
 }
 // An actual source revision change after collection blocks settlement entirely.
 const changed=await f.request('/records/constituents/'+f.donor.id,{method:'PATCH',body:{version:f.row('constituents',f.donor.id).version,notes:'Reviewed source changed after the simulated collection'}});
 assert.equal(changed.status,200,changed.text);
 const financial=f.financial();
 const blocked=await f.settle(stale.collection);
 assert.equal(blocked.status,409,blocked.text);
 assert.equal(f.gifts(),0);
 assert.deepEqual(f.financial(),financial);
 assert.equal((await f.detail(stale.intention.id)).sourceCurrent,false);
});

test('a suspended workspace and a changed account cannot commit a settlement',async t=>{
 const f=await fixture(t);
 const p=await f.collected();
 const before=f.snapshot();
 f.active=false;
 assert.equal((await f.settle(p.collection)).status,503);
 assert.equal((await f.collect(p.collection)).status,503);
 f.active=true;
 assert.deepEqual(f.snapshot(),before);
 f.db.prepare('UPDATE users SET version=version+1 WHERE id=?').run(f.sessions.admin.user.id);
 const changed=await f.settle(p.collection);
 assert.ok([401,403,409].includes(changed.status),changed.text);
 assert.equal(f.gifts(),0);
 f.sessions.admin=await f.login();
 assert.deepEqual(f.snapshot(),before);
 const recovered=await f.settle((await f.detail(p.intention.id)).collections[0]);
 assert.equal(recovered.status,201,recovered.text);
 assert.equal(f.gifts(),1);
});

test('a poisoned gift write, audit failure or deferred COMMIT failure rolls back every recurring row together',async t=>{
 const f=await fixture(t);
 const p=await f.collected();
 const before=f.snapshot();
 const faults=[
  "CREATE TRIGGER synthetic_recurring_fault AFTER INSERT ON records WHEN NEW.collection='gifts' BEGIN UPDATE records SET data=json_set(data,'$.amount',10002,'$.allocations[0].amount',10002) WHERE id=NEW.id; END",
  "CREATE TRIGGER synthetic_recurring_fault AFTER INSERT ON records WHEN NEW.collection='gifts' BEGIN UPDATE records SET data=json_set(data,'$.unexpectedProviderFlag','Paid') WHERE id=NEW.id; END",
  "CREATE TRIGGER synthetic_recurring_fault BEFORE INSERT ON audit WHEN NEW.action='record_recurring_gift' BEGIN SELECT RAISE(ABORT,'Synthetic financial audit unavailable'); END"
 ];
 for(const sql of faults){
  f.db.exec(sql);
  const r=await f.settle(p.collection);
  assert.ok([409,500,503].includes(r.status),sql+' → '+r.text);
  assert.deepEqual(f.snapshot(),before,'no partial financial or ledger state survives');
  f.db.exec('DROP TRIGGER synthetic_recurring_fault');
 }
 f.db.exec("CREATE TABLE synthetic_recurring_commit_fault(owner_id TEXT REFERENCES users(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER synthetic_recurring_fault AFTER INSERT ON recurring_gift_links BEGIN INSERT INTO synthetic_recurring_commit_fault VALUES('no-such-owner'); END");
 const deferred=await f.settle(p.collection);
 assert.equal(deferred.status,500,deferred.text);
 assert.deepEqual(f.snapshot(),before);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM synthetic_recurring_commit_fault').get().n,0);
 f.db.exec('DROP TRIGGER synthetic_recurring_fault');
 assert.equal((await f.settle(p.collection)).status,201);
 assert.equal(f.gifts(),1);
});

test('two independent SQLite writers settle one collection as exactly one posted gift',async t=>{
 const f=await fixture(t);
 const p=await f.collected();
 const body={version:p.collection.version,donorVersion:1,campaignVersion:1,designationVersion:1,reason:'Concurrent explicit financial review',reviewConfirmed:true};
 const code=`const {parentPort,workerData}=require('node:worker_threads');(async()=>{const {createApp}=await import(workerData.appUrl);
  const app=createApp({dbPath:workerData.dbPath,seed:false,tenantId:workerData.tenantId,initialAdmin:workerData.initialAdmin,workflowWorker:false,reminderWorker:false,extensions:{recurringGiving:{mode:'TEST_ONLY',adapter:{collect:async()=>{throw Error('Unexpected provider call during settlement');}},adjustmentSecret:workerData.adjustmentSecret,donorTokenSecret:workerData.donorTokenSecret}}});
  app.locals.db.exec('PRAGMA busy_timeout=5000');
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port+'/api';
  const auth=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:workerData.initialAdmin.email,password:workerData.initialAdmin.password})});
  if(auth.status!==200)throw Error('Synthetic reviewer login failed');
  const session=await auth.json(),cookie=auth.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  parentPort.postMessage({ready:true});
  parentPort.once('message',async()=>{try{const r=await fetch(base+'/recurring-giving/collections/'+workerData.collectionId+'/record-gift',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':session.csrfToken},body:JSON.stringify(workerData.body)});
   const result={status:r.status,json:await r.json()};await new Promise(resolve=>server.close(resolve));app.locals.close();parentPort.postMessage({result});}
   catch(error){server.close();app.locals.close();parentPort.postMessage({error:error.message});}});
 })().catch(error=>parentPort.postMessage({error:error.message}));`;
 async function start(){const w=new Worker(code,{eval:true,workerData:{appUrl:new URL('../server/app.js',import.meta.url).href,dbPath:f.dbPath,tenantId:f.tenantId,initialAdmin:f.initialAdmin,collectionId:p.collection.id,body,adjustmentSecret,donorTokenSecret}});
  t.after(()=>w.terminate());
  await new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',m=>m.ready?resolve():reject(Error(m.error)));});return w;}
 const workers=[await start(),await start()];
 const promises=workers.map(w=>new Promise((resolve,reject)=>{w.once('error',reject);w.once('message',m=>m.error?reject(Error(m.error)):resolve(m.result));}));
 for(const w of workers)w.postMessage('settle');
 const results=await Promise.all(promises);
 assert.ok(results.every(r=>[200,201,409].includes(r.status)),JSON.stringify(results));
 assert.equal(results.filter(r=>r.status===201).length,1,'exactly one writer creates the gift: '+JSON.stringify(results));
 assert.equal(f.gifts(),1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recurring_gift_links').get().n,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='record_recurring_gift'").get().n,1);
});

test('a posted recurring gift cannot be rewritten, and voiding it is a separate reasoned action that is never bypassed',async t=>{
 const f=await fixture(t);
 const p=await f.collected();
 const posted=await f.settle(p.collection);assert.equal(posted.status,201,posted.text);
 const giftId=posted.json.giftId,gift=f.row('gifts',giftId);
 // A coherent, schema-valid financial rewrite still cannot pass the recurring custody guard.
 const rewrite=await f.request('/records/gifts/'+giftId,{method:'PATCH',body:{version:gift.version,amount:20002,allocations:[{designationId:f.fund.id,amount:20002}],correctionReason:'Attempted silent rewrite'}});
 assert.equal(rewrite.status,409,rewrite.text);
 assert.match(rewrite.json.error,/cannot be rewritten/);
 assert.equal(f.row('gifts',giftId).amount,10001,'exact integer cents are preserved');
 assert.equal((await f.request('/records/gifts/'+giftId,{method:'DELETE',body:{version:gift.version}})).status,403);
 const merge=await f.request('/records/constituents/'+f.donor.id,{method:'PATCH',body:{version:f.row('constituents',f.donor.id).version,type:'Business'}});
 assert.equal(merge.status,409,'retained recurring donor custody prevents identity replacement');
 // A void remains available as an explicit reasoned native action and is never skipped.
 const voided=await f.request('/gifts/'+giftId+'/void',{method:'POST',body:{version:f.row('gifts',giftId).version,reason:'Reviewed native void after donor dispute'}});
 assert.equal(voided.status,200,voided.text);
 assert.equal(f.row('gifts',giftId).status,'Voided');
 assert.equal((await f.detail(p.intention.id)).recordedCashCents,0,'a void removes the recorded income');
 assert.equal(f.gifts(),1,'voiding retains the original row rather than deleting it');
 const resettle=await f.settle((await f.detail(p.intention.id)).collections[0]);
 assert.ok([200,409].includes(resettle.status),resettle.text);
 assert.equal(f.gifts(),1,'a void never re-opens the collection for a second gift');
});

test('a signed adjustment is tenant scoped, replay defended and refused when its facts do not match the retained collection',async t=>{
 const f=await fixture(t);
 const p=await f.collected();
 assert.equal((await f.settle(p.collection)).status,201);
 const before=f.snapshot();
 const base={id:'adj_'+randomUUID(),collectionId:p.collection.id,providerRef:p.collection.providerRef,type:'refund',amountCents:1,currency:'usd',mode:'TEST_ONLY'};
 for(const mutate of [a=>{a.providerRef='rc_test_foreign';},a=>{a.amountCents=10002;},a=>{a.collectionId=randomUUID();}]){
  const adjustment={...base,id:'adj_'+randomUUID()};mutate(adjustment);
  const r=await f.request('/recurring-giving/adjustments',{method:'POST',body:{adjustment,signature:sign(adjustment)}});
  assert.ok([400,404,409].includes(r.status),JSON.stringify(adjustment)+' → '+r.text);
  assert.deepEqual(f.snapshot(),before);
 }
 // A correctly signed but tampered body never verifies.
 const tampered={...base};const signature=sign(tampered);tampered.amountCents=2;
 assert.equal((await f.request('/recurring-giving/adjustments',{method:'POST',body:{adjustment:tampered,signature}})).status,400);
 assert.deepEqual(f.snapshot(),before);
 const applied=await f.request('/recurring-giving/adjustments',{method:'POST',body:{adjustment:base,signature:sign(base)}});
 assert.equal(applied.status,200,applied.text);
 const retained=f.snapshot();
 assert.equal((await f.request('/recurring-giving/adjustments',{method:'POST',body:{adjustment:base,signature:sign(base)}})).json.replayed,true);
 assert.deepEqual(f.snapshot(),retained,'a replayed adjustment changes nothing');
 assert.equal(f.financial().length,before.records.filter(r=>['gifts','pledges','campaigns'].includes(r.collection)).length);
});

test('bounded recovery survives restart and never exceeds its attempt ceiling',async t=>{
 const f=await fixture(t);
 const i=await f.intention();
 f.outcome={outcome:'failed',failureCode:'do_not_honor'};
 let collection=i.collections[0];
 for(let attempt=1;attempt<=2;attempt++){
  const r=await f.collect(collection);assert.equal(r.status,200,r.text);
  assert.equal(r.json.collection.attemptCount,attempt);
  collection=r.json.collection;f.advanceDays(2);
 }
 await f.restart();
 const live=await f.detail(i.id);
 assert.equal(live.collections[0].attemptCount,2,'attempt counters survive restart');
 assert.equal(live.dunning,'Retrying');
 collection=live.collections[0];
 for(let attempt=3;attempt<=4;attempt++){
  const r=await f.collect(collection);assert.equal(r.status,200,r.text);
  collection=r.json.collection;f.advanceDays(2);
 }
 assert.equal(collection.status,'ReviewRequired');
 assert.equal(f.calls.length,4,'the attempt ceiling holds across a restart');
 assert.equal((await f.collect(collection)).status,409);
 assert.equal(f.calls.length,4);
 assert.equal(f.gifts(),0);
});
