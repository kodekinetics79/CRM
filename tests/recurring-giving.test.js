import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID,createHmac} from 'node:crypto';
import {createApp} from '../server/app.js';
import {advance} from '../server/recurringGiving.js';

const password='SyntheticRecurringGiving!2026',adjustmentSecret='synthetic-adjustment-secret-key',donorTokenSecret='synthetic-donor-token-secret-key';
const iso=ms=>new Date(ms).toISOString().slice(0,10);
const canonical=v=>v&&typeof v==='object'?Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
const sign=payload=>createHmac('sha256',adjustmentSecret).update(canonical(payload)).digest('hex');

async function fixture(t,{configured=true,seedClock=Date.parse('2026-09-15T12:00:00Z')}={}){
 const tenantId=randomUUID(),calls=[];let nowMs=seedClock,outcome=null,throwNext=false;
 const clock=()=>nowMs;
 // TEST_ONLY adapter. It performs no network I/O of any kind.
 const adapter={async collect(request){calls.push(structuredClone(request));if(throwNext){throwNext=false;throw new Error('Synthetic simulated transport interruption');}
  if(outcome)return typeof outcome==='function'?outcome(request):structuredClone(outcome);
  return {outcome:'succeeded',providerRef:'rc_test_'+randomUUID().replaceAll('-',''),amountCents:request.amountCents,currency:'usd',method:'ACH',collectedAt:new Date(nowMs).toISOString(),mode:'TEST_ONLY'};}};
 // A configured workspace runs on the injected clock, so "today" is the seeded date and
 // the first occurrence falls due immediately. An unconfigured workspace has no config to
 // carry a clock, so the server uses the real date: pin its start date a day ahead of the
 // real clock so the suite cannot fail purely because UTC rolled past midnight mid-run.
 const startDate=()=>configured?iso(nowMs):iso(Date.now()+86400000);
 const extensions=configured?{recurringGiving:{mode:'TEST_ONLY',adapter,adjustmentSecret,donorTokenSecret,clock},publicGiving:{mode:'TEST_ONLY',tokenSecret:donorTokenSecret,allowedOrigins:['http://127.0.0.1:5173'],clock}}:{};
 const app=createApp({seed:false,tenantId,initialAdmin:{name:'Synthetic recurring administrator',email:'recurring.admin@example.test',password},workflowWorker:false,reminderWorker:false,extensions});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.locals.close();});
 const base='http://127.0.0.1:'+server.address().port;
 const sessions={};
 async function request(path,{method='GET',body,session=sessions.admin,csrf=true,headers={}}={}){
  const r=await fetch(base+'/api'+path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(session?{Cookie:session.cookie,...(csrf?{'X-CSRF-Token':session.csrfToken}:{})}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await r.text();let json;try{json=JSON.parse(text);}catch{json=null;}return {status:r.status,json,text,headers:r.headers};
 }
 async function login(email='recurring.admin@example.test'){const r=await request('/auth/login',{method:'POST',session:null,body:{email,password}});assert.equal(r.status,200,r.text);return {...r.json,cookie:r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')};}
 sessions.admin=await login();
 for(const role of ['staff','viewer','event-helper']){const r=await request('/users',{method:'POST',body:{name:'Synthetic recurring '+role,email:role+'.recurring@example.test',role,password}});assert.equal(r.status,201,r.text);sessions[role]=await login(role+'.recurring@example.test');}
 async function create(collection,fields){const r=await request('/records/'+collection,{method:'POST',body:fields});assert.equal(r.status,201,r.text);return r.json.record;}
 const donor=await create('constituents',{name:'Actual recurring supporter',type:'Individual',email:'supporter.recurring@example.test',preference:'Do not contact'});
 const campaign=await create('campaigns',{name:'Synthetic sustaining giving',type:'Annual',goal:999999,startDate:'2026-01-01',endDate:'2027-12-31',status:'Active'});
 const fund=await create('designations',{name:'Actual sustaining fund',accountCode:'RECURRING-100'});
 const row=(collection,id)=>JSON.parse(app.locals.db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get(collection,id).data);
 const gifts=()=>app.locals.db.prepare("SELECT data FROM records WHERE collection='gifts' ORDER BY rowid").all().map(r=>JSON.parse(r.data));
 const financial=()=>app.locals.db.prepare("SELECT * FROM records WHERE collection IN ('gifts','pledges','campaigns') ORDER BY rowid").all();
 const payload=(changes={})=>({requestId:randomUUID(),kind:'RecurringPayment',donorId:donor.id,donorVersion:row('constituents',donor.id).version,campaignId:campaign.id,campaignVersion:row('campaigns',campaign.id).version,designationId:fund.id,designationVersion:row('designations',fund.id).version,amountCents:10001,currency:'usd',frequency:'Monthly',startDate:startDate(),occurrences:3,reason:'Reviewed synthetic sustaining commitment',reviewConfirmed:true,...changes});
 async function intention(changes={}){const r=await request('/recurring-giving/intentions',{method:'POST',body:payload(changes)});assert.equal(r.status,201,r.text);return r.json.intention;}
 async function detail(id,session){const r=await request('/recurring-giving/intentions/'+id,{session});assert.equal(r.status,200,r.text);return r.json;}
 async function collect(c,changes={}){return request('/recurring-giving/collections/'+c.id+'/collect',{method:'POST',body:{version:c.version,reason:'Reviewed simulated collection attempt',testModeConfirmed:true,...changes}});}
 async function settle(c,changes={}){return request('/recurring-giving/collections/'+c.id+'/record-gift',{method:'POST',body:{version:c.version,donorVersion:row('constituents',donor.id).version,campaignVersion:row('campaigns',campaign.id).version,designationVersion:row('designations',fund.id).version,reason:'Explicit reviewed recurring settlement',reviewConfirmed:true,...changes}});}
 return {app,tenantId,sessions,request,login,create,donor,campaign,fund,row,gifts,financial,payload,intention,detail,collect,settle,calls,adapter,
  get db(){return app.locals.db;},get service(){return app.locals.extensions.services.recurringGiving;},
  get now(){return nowMs;},set now(v){nowMs=v;},advanceDays(days){nowMs+=days*86400000;},
  set outcome(v){outcome=v;},set throwNext(v){throwNext=v;}};
}

test('calendar advance clamps month ends and never silently skips a period',()=>{
 assert.equal(advance('2026-01-31','Monthly'),'2026-02-28');
 assert.equal(advance('2028-01-31','Monthly'),'2028-02-29');
 assert.equal(advance('2026-11-30','Quarterly'),'2027-02-28');
 assert.equal(advance('2026-02-29','Annual'),'2027-02-28');
 assert.equal(advance('2026-09-15','Monthly'),'2026-10-15');
 assert.equal(advance('2026-12-15','Monthly'),'2027-01-15');
});

test('an unconfigured workspace keeps manual entry primary and offers no simulated collection instruction',async t=>{
 const f=await fixture(t,{configured:false});
 const status=await f.request('/recurring-giving/status');assert.equal(status.status,200,status.text);
 assert.deepEqual([status.json.enabled,status.json.mode,status.json.manualEntryPrimary],[false,'Disabled',true]);
 const denied=await f.request('/recurring-giving/intentions',{method:'POST',body:f.payload()});assert.equal(denied.status,503,denied.text);
 const pledge=await f.intention({kind:'Pledge'});assert.equal(pledge.kind,'Pledge');assert.equal(pledge.commitmentOnly,true);assert.equal(pledge.mode,'ManualOnly');
 assert.equal((await f.request('/api/public/giving/status'.replace('/api',''))).status,503);
 assert.equal(f.gifts().length,0);
});

test('a pledge is a commitment and a recurring payment is a collection instruction; neither is income until a gift is posted',async t=>{
 const f=await fixture(t);
 const pledge=await f.intention({kind:'Pledge',amountCents:25000,frequency:'Quarterly',occurrences:4});
 assert.equal(pledge.commitmentOnly,true);assert.equal(pledge.committedCents,100000);assert.equal(pledge.recordedCashCents,0);
 assert.equal(pledge.collections.length,1);assert.equal(pledge.collections[0].status,'Scheduled');
 const refused=await f.collect(pledge.collections[0]);assert.equal(refused.status,409,refused.text);
 assert.match(refused.json.error,/commitment, not a collection instruction/);
 assert.equal(f.calls.length,0);assert.equal(f.gifts().length,0);

 const recurring=await f.intention({amountCents:10001,occurrences:3});
 assert.equal(recurring.commitmentOnly,false);assert.equal(recurring.recordedCashCents,0);
 const collected=await f.collect(recurring.collections[0]);assert.equal(collected.status,200,collected.text);
 assert.equal(collected.json.collection.status,'Collected');assert.equal(f.calls.length,1);
 assert.equal(f.gifts().length,0,'a simulated collection is evidence, not income');
 assert.equal((await f.detail(recurring.id)).intention.recordedCashCents,0);
});

test('explicit settlement posts exactly one gift of the exact integer cents and repeats are idempotent',async t=>{
 const f=await fixture(t);
 const i=await f.intention({amountCents:10001});
 const collected=await f.collect(i.collections[0]);assert.equal(collected.status,200,collected.text);
 const posted=await f.settle(collected.json.collection);assert.equal(posted.status,201,posted.text);
 const all=f.gifts();assert.equal(all.length,1);
 const gift=all[0];
 assert.equal(gift.amount,10001);
 assert.deepEqual(gift.allocations,[{designationId:f.fund.id,amount:10001}]);
 assert.equal(gift.allocations.reduce((n,a)=>n+a.amount,0),gift.amount);
 assert.equal(gift.constituentId,f.donor.id);assert.equal(gift.campaignId,f.campaign.id);
 assert.equal(gift.giftKind,'Recurring');assert.equal(gift.method,'ACH');assert.equal(gift.status,'Posted');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM receipt_issues').get().n,0,'settlement issues no receipt');
 assert.ok(!gift.acknowledgment,'settlement claims no acknowledgment');
 const before=f.financial();
 for(let attempt=0;attempt<3;attempt++){const again=await f.settle((await f.detail(i.id)).intention.collections[0]);assert.ok([200,201,409].includes(again.status),again.text);}
 assert.equal(f.gifts().length,1,'duplicate settlement never duplicates revenue');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recurring_gift_links').get().n,1);
 assert.deepEqual(f.financial(),before);
 assert.equal((await f.detail(i.id)).intention.recordedCashCents,10001);
});

test('a pledge installment settles through reviewed manual entry with the actual received method and date',async t=>{
 const f=await fixture(t);
 const pledge=await f.intention({kind:'Pledge',amountCents:50000,frequency:'Monthly',occurrences:2});
 const collection=pledge.collections[0];
 assert.equal((await f.settle(collection,{method:'Check'})).status,400,'a received date is required');
 assert.equal((await f.settle(collection,{method:'Check',receivedDate:iso(f.now+5*86400000)})).status,400,'a future received date is refused');
 const posted=await f.settle(collection,{method:'Check',receivedDate:iso(f.now)});
 assert.equal(posted.status,201,posted.text);
 const gift=f.gifts()[0];
 assert.equal(gift.amount,50000);assert.equal(gift.method,'Check');assert.equal(gift.giftKind,'Pledge fulfillment');
 assert.equal(gift.date,iso(f.now));
 assert.equal(f.calls.length,0,'a pledge never contacts the collection adapter');
});

test('scheduling advances the calendar, stops at the committed occurrence count and creates no income',async t=>{
 const f=await fixture(t);
 const i=await f.intention({amountCents:2500,frequency:'Monthly',occurrences:3});
 assert.equal(i.collections.length,1);assert.equal(i.nextDue,advance(i.startDate,'Monthly'));
 f.advanceDays(40);assert.equal(f.service.runDueSchedules().scheduled,1);
 f.advanceDays(40);assert.equal(f.service.runDueSchedules().scheduled,1);
 const full=(await f.detail(i.id)).intention;
 assert.equal(full.collections.length,3);
 assert.deepEqual(full.collections.map(c=>c.sequence),[1,2,3]);
 assert.equal(full.status,'Completed');assert.equal(full.nextDue,null);
 f.advanceDays(400);assert.equal(f.service.runDueSchedules().scheduled,0,'a completed commitment never over-schedules');
 assert.equal(f.gifts().length,0);
 assert.ok(full.collections.every(c=>c.amountCents===2500));
});

test('pause, resume and cancel retain reasons and history and never rewrite posted gifts',async t=>{
 const f=await fixture(t);
 const i=await f.intention({occurrences:12});
 const paused=await f.request('/recurring-giving/intentions/'+i.id+'/pause',{method:'POST',body:{version:i.version,reason:'Donor asked for a seasonal pause'}});
 assert.equal(paused.status,200,paused.text);assert.equal(paused.json.intention.status,'Paused');
 f.advanceDays(40);assert.equal(f.service.runDueSchedules().scheduled,0,'a paused intention schedules nothing');
 const collected=await f.collect(paused.json.intention.collections[0]);assert.equal(collected.status,409,'a paused intention collects nothing');
 const resumed=await f.request('/recurring-giving/intentions/'+i.id+'/resume',{method:'POST',body:{version:paused.json.intention.version,reason:'Donor asked to resume'}});
 assert.equal(resumed.status,200,resumed.text);assert.equal(resumed.json.intention.status,'Active');
 const settled=await f.collect(resumed.json.intention.collections[0]);assert.equal(settled.status,200,settled.text);
 const posted=await f.settle(settled.json.collection);assert.equal(posted.status,201,posted.text);
 // Let a further occurrence fall due so cancellation has pending work to retire.
 f.advanceDays(40);assert.equal(f.service.runDueSchedules().scheduled,1);
 const pending=(await f.detail(i.id)).intention;
 assert.equal(pending.collections.filter(c=>c.status==='Scheduled').length,1);
 const before=f.financial();
 const cancelled=await f.request('/recurring-giving/intentions/'+i.id+'/cancel',{method:'POST',body:{version:pending.version,reason:'Donor ended the commitment'}});
 assert.equal(cancelled.status,200,cancelled.text);assert.equal(cancelled.json.intention.status,'Cancelled');
 assert.deepEqual(f.financial(),before,'cancellation never rewrites posted gifts');
 assert.equal(cancelled.json.intention.collections.filter(c=>c.status==='Cancelled').length,1,'pending occurrences are retired');
 assert.equal(cancelled.json.intention.collections.filter(c=>c.status==='GiftRecorded').length,1,'settled occurrences are retained');
 assert.equal(cancelled.json.intention.recordedCashCents,10001,'recorded income survives cancellation');
 assert.equal((await f.request('/recurring-giving/intentions/'+i.id+'/resume',{method:'POST',body:{version:cancelled.json.intention.version,reason:'Attempted revival'}})).status,409);
 assert.throws(()=>f.db.prepare("UPDATE recurring_intentions SET status='Active' WHERE id=?").run(i.id),/cannot resume/);
 const {history}=await f.detail(i.id);
 for(const action of ['Created','Paused','Resumed','Cancelled'])assert.ok(history.some(h=>h.action===action),action+' is retained');
 assert.ok(history.some(h=>h.reason==='Donor asked for a seasonal pause'));
 assert.throws(()=>f.db.prepare('DELETE FROM recurring_history').run(),/retained/);
});

test('failed collections recover through bounded retries and dunning states rather than unbounded attempts',async t=>{
 const f=await fixture(t);
 const i=await f.intention({occurrences:6});
 let collection=i.collections[0];
 f.outcome={outcome:'failed',failureCode:'insufficient_funds'};
 for(let attempt=1;attempt<=3;attempt++){
  const r=await f.collect(collection);assert.equal(r.status,200,r.text);
  assert.equal(r.json.collection.status,'AttemptFailed');
  assert.equal(r.json.collection.attemptCount,attempt);
  assert.equal(r.json.collection.lastErrorCode,'insufficient_funds');
  assert.equal(r.json.intention.dunning,'Retrying');
  const tooSoon=await f.collect(r.json.collection);assert.equal(tooSoon.status,409,'a bounded retry window is enforced');
  f.advanceDays(2);
  collection=r.json.collection;
 }
 const exhausted=await f.collect(collection);assert.equal(exhausted.status,200,exhausted.text);
 assert.equal(exhausted.json.collection.status,'ReviewRequired');
 assert.equal(exhausted.json.collection.attemptCount,4);
 assert.equal(exhausted.json.intention.dunning,'Exhausted');
 assert.equal(exhausted.json.intention.status,'ReviewRequired');
 assert.equal(f.calls.length,4,'attempts are bounded');
 assert.equal((await f.collect(exhausted.json.collection)).status,409);
 assert.equal(f.calls.length,4);
 assert.equal(f.gifts().length,0,'a failed collection never posts income');
 assert.equal((await f.settle(exhausted.json.collection)).status,409);
 assert.equal(f.gifts().length,0);
 f.outcome=null;
 const resumed=await f.request('/recurring-giving/intentions/'+i.id+'/resume',{method:'POST',body:{version:exhausted.json.intention.version,reason:'Donor supplied a new instruction after review'}});
 assert.equal(resumed.status,200,resumed.text);assert.equal(resumed.json.intention.dunning,'None');
});

test('signed simulated refund, dispute and cancellation require review and never void a posted gift automatically',async t=>{
 const f=await fixture(t);
 for(const type of ['refund','dispute','cancellation']){
  const i=await f.intention({occurrences:2});
  const collected=await f.collect(i.collections[0]);assert.equal(collected.status,200,collected.text);
  const posted=await f.settle(collected.json.collection);assert.equal(posted.status,201,posted.text);
  const before=f.financial();
  const adjustment={id:'adj_'+randomUUID(),collectionId:collected.json.collection.id,providerRef:collected.json.collection.providerRef,type,amountCents:1,currency:'usd',mode:'TEST_ONLY'};
  const signature=sign(adjustment);
  const bad=await f.request('/recurring-giving/adjustments',{method:'POST',body:{adjustment,signature:'0'.repeat(signature.length)}});
  assert.equal(bad.status,400,bad.text);assert.deepEqual(f.financial(),before);
  const applied=await f.request('/recurring-giving/adjustments',{method:'POST',body:{adjustment,signature}});
  assert.equal(applied.status,200,applied.text);
  assert.equal(applied.json.collection.status,'ReviewRequired');
  assert.equal(f.row('gifts',posted.json.giftId).status,'Posted','a signed adjustment never guesses a native void');
  assert.deepEqual(f.financial(),before);
  const replay=await f.request('/recurring-giving/adjustments',{method:'POST',body:{adjustment,signature}});
  assert.equal(replay.status,200,replay.text);assert.equal(replay.json.replayed,true);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recurring_adjustments WHERE id=?').get(adjustment.id).n,1);
  assert.deepEqual(f.financial(),before);
 }
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='gifts'").get().n,3);
});

test('recurring giving default-denies viewers and helpers, limits staff to reading and requires CSRF', async t=>{
 const f=await fixture(t);
 const i=await f.intention();
 const before=f.financial();
 for(const role of ['viewer','event-helper'])for(const path of ['/recurring-giving/status','/recurring-giving/intentions','/recurring-giving/intentions/'+i.id])
  assert.equal((await f.request(path,{session:f.sessions[role]})).status,403,role+' '+path);
 for(const path of ['/recurring-giving/status','/recurring-giving/intentions','/recurring-giving/intentions/'+i.id])
  assert.equal((await f.request(path,{session:f.sessions.staff})).status,200,'staff may read '+path);
 for(const [path,body] of [['/recurring-giving/intentions',f.payload()],['/recurring-giving/intentions/'+i.id+'/cancel',{version:i.version,reason:'Unauthorized'}],['/recurring-giving/collections/'+i.collections[0].id+'/collect',{version:1,reason:'Unauthorized',testModeConfirmed:true}]])
  for(const role of ['staff','viewer','event-helper'])assert.equal((await f.request(path,{method:'POST',body,session:f.sessions[role]})).status,403,role+' '+path);
 assert.equal((await f.request('/recurring-giving/intentions',{method:'POST',body:f.payload(),csrf:false})).status,403);
 assert.deepEqual(f.financial(),before);
 assert.equal(f.gifts().length,0);
});

test('intentions are tenant scoped and a foreign workspace row is never listed, opened or settled',async t=>{
 const f=await fixture(t);
 const mine=await f.intention();
 const foreignTenant=randomUUID(),foreignId=randomUUID(),at=new Date(f.now).toISOString();
 const source=JSON.parse(f.db.prepare('SELECT source_json FROM recurring_intentions WHERE id=?').get(mine.id).source_json);
 f.db.prepare('INSERT INTO recurring_intentions(id,tenant_id,version,kind,status,source_json,source_digest,amount_cents,frequency,start_date,occurrences,next_due,dunning,request_id,recovery_marker,token_hash,created_at,updated_at,last_error_code) VALUES(?,?,1,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,NULL)')
  .run(foreignId,foreignTenant,'RecurringPayment','Active',JSON.stringify(source),f.db.prepare('SELECT source_digest FROM recurring_intentions WHERE id=?').get(mine.id).source_digest,999999,'Monthly',mine.startDate,1,mine.startDate,'None',randomUUID(),'none',at,at);
 const list=await f.request('/recurring-giving/intentions');assert.equal(list.status,200,list.text);
 assert.deepEqual(list.json.intentions.map(x=>x.id),[mine.id]);
 assert.equal((await f.request('/recurring-giving/intentions/'+foreignId)).status,404);
 assert.equal(f.service.runDueSchedules().scheduled,0,'foreign tenant rows are never scheduled');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recurring_collections WHERE intention_id=?').get(foreignId).n,0);
 assert.equal(f.gifts().length,0);
});

test('an exact reviewed request replays to the original intention and a changed request is refused',async t=>{
 const f=await fixture(t);
 const body=f.payload();
 const first=await f.request('/recurring-giving/intentions',{method:'POST',body});assert.equal(first.status,201,first.text);
 assert.equal(first.json.replayed,false);
 const repeat=await f.request('/recurring-giving/intentions',{method:'POST',body});assert.equal(repeat.status,201,repeat.text);
 assert.equal(repeat.json.replayed,true);assert.equal(repeat.json.intention.id,first.json.intention.id);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recurring_intentions').get().n,1);
 for(const change of [{amountCents:20002},{frequency:'Annual'},{kind:'Pledge'},{occurrences:9}]){
  const drift=await f.request('/recurring-giving/intentions',{method:'POST',body:{...body,...change}});
  assert.equal(drift.status,409,drift.text);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recurring_intentions').get().n,1);
 }
});

