import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID,createHmac} from 'node:crypto';
import {createApp} from '../server/app.js';

const password='SyntheticPublicGiving!2026',adjustmentSecret='synthetic-public-adjustment-secret',donorTokenSecret='synthetic-public-donor-token-secret';
const iso=ms=>new Date(ms).toISOString().slice(0,10);
// The allowed origin is deliberately one that the workspace also allows, so that a
// refusal proves this module's own origin check rather than the shared API guard.
const ALLOWED='http://127.0.0.1:5173',WORKSPACE_ONLY='http://localhost:5173';

function mintToken({secret=donorTokenSecret,tenantId,intentionId,expiresAt}){
 const payload={t:tenantId,i:intentionId,n:randomUUID(),e:expiresAt};
 const encoded='v1.'+Buffer.from(JSON.stringify(payload),'utf8').toString('base64url');
 return encoded+'.'+createHmac('sha256',secret).update(encoded).digest('hex');
}

async function fixture(t,{configured=true}={}){
 const tenantId=randomUUID();let nowMs=Date.parse('2026-09-15T12:00:00Z');
 const clock=()=>nowMs;
 const adapter={async collect(request){return {outcome:'succeeded',providerRef:'rc_test_'+randomUUID().replaceAll('-',''),amountCents:request.amountCents,currency:'usd',method:'ACH',collectedAt:new Date(nowMs).toISOString(),mode:'TEST_ONLY'};}};
 const extensions=configured?{recurringGiving:{mode:'TEST_ONLY',adapter,adjustmentSecret,donorTokenSecret,clock},publicGiving:{mode:'TEST_ONLY',tokenSecret:donorTokenSecret,allowedOrigins:[ALLOWED],clock}}:{};
 const app=createApp({seed:false,tenantId,initialAdmin:{name:'Synthetic public administrator',email:'public.admin@example.test',password},workflowWorker:false,reminderWorker:false,extensions});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await new Promise(r=>server.close(r));app.locals.close();});
 const base='http://127.0.0.1:'+server.address().port;
 let admin=null;
 async function request(path,{method='GET',body,session,csrf=true,headers={}}={}){
  const r=await fetch(base+'/api'+path,{method,headers:{...(body===undefined?{}:{'Content-Type':'application/json'}),...(session?{Cookie:session.cookie,...(csrf?{'X-CSRF-Token':session.csrfToken}:{})}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const text=await r.text();let json;try{json=JSON.parse(text);}catch{json=null;}return {status:r.status,json,text,headers:r.headers};
 }
 const publicRequest=(path,options={})=>request('/public/giving'+path,{...options,session:null});
 if(configured){
  const auth=await request('/auth/login',{method:'POST',body:{email:'public.admin@example.test',password}});
  assert.equal(auth.status,200,auth.text);
  admin={...auth.json,cookie:auth.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')};
 }
 async function create(collection,fields){const r=await request('/records/'+collection,{method:'POST',body:fields,session:admin});assert.equal(r.status,201,r.text);return r.json.record;}
 let donor=null,campaign=null,fund=null;
 if(configured){
  donor=await create('constituents',{name:'Actual public supporter',type:'Individual',email:'public.supporter@example.test',preference:'Do not contact'});
  campaign=await create('campaigns',{name:'Synthetic public giving',type:'Annual',goal:999999,startDate:'2026-01-01',endDate:'2027-12-31',status:'Active'});
  fund=await create('designations',{name:'Actual public fund',accountCode:'PUBLIC-100'});
 }
 const row=(collection,id)=>JSON.parse(app.locals.db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get(collection,id).data);
 const gifts=()=>app.locals.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='gifts'").get().n;
 const constituents=()=>app.locals.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='constituents'").get().n;
 const financial=()=>app.locals.db.prepare("SELECT * FROM records WHERE collection IN ('gifts','pledges','campaigns','constituents') ORDER BY rowid").all();
 const submission=(changes={})=>({requestId:randomUUID(),kind:'OneTime',amountCents:2500,frequency:null,supporterName:'Actual public supporter',supporterEmail:'supporter@example.test',message:'Synthetic public request',acknowledged:true,...changes});
 async function intention(changes={}){
  const r=await request('/recurring-giving/intentions',{method:'POST',session:admin,body:{requestId:randomUUID(),kind:'RecurringPayment',donorId:donor.id,donorVersion:row('constituents',donor.id).version,campaignId:campaign.id,campaignVersion:row('campaigns',campaign.id).version,designationId:fund.id,designationVersion:row('designations',fund.id).version,amountCents:10001,currency:'usd',frequency:'Monthly',startDate:iso(nowMs),occurrences:6,reason:'Reviewed synthetic public commitment',reviewConfirmed:true,...changes}});
  assert.equal(r.status,201,r.text);return r.json.intention;
 }
 async function donorLink(i){const r=await request('/recurring-giving/intentions/'+i.id+'/donor-link',{method:'POST',session:admin,body:{version:i.version,reason:'Issued a reviewed donor self-service link',expiresInDays:30}});assert.equal(r.status,201,r.text);return r.json;}
 return {app,tenantId,base,request,publicRequest,create,donor,campaign,fund,row,gifts,constituents,financial,submission,intention,donorLink,
  get admin(){return admin;},get db(){return app.locals.db;},get now(){return nowMs;},advanceDays(d){nowMs+=d*86400000;}};
}

test('an unconfigured public surface exposes nothing and never claims an available payment path',async t=>{
 const f=await fixture(t,{configured:false});
 for(const path of ['/status','/return'])assert.equal((await f.publicRequest(path)).status,503);
 const denied=await f.publicRequest('/submissions',{method:'POST',body:f.submission()});
 assert.equal(denied.status,503,denied.text);
 assert.equal(f.gifts(),0);
});

test('a public submission records no income, no constituent and no consent change',async t=>{
 const f=await fixture(t);
 const status=await f.publicRequest('/status');
 assert.equal(status.status,200,status.text);
 assert.equal(status.json.acceptsPayment,false);
 assert.equal(status.json.incomeRecorded,false);
 assert.equal(status.json.manualEntryPrimary,true);
 const before=f.financial(),constituents=f.constituents(),preference=f.row('constituents',f.donor.id).preference;
 const body=f.submission({kind:'RecurringPayment',frequency:'Monthly',amountCents:5000});
 const sent=await f.publicRequest('/submissions',{method:'POST',body});
 assert.equal(sent.status,201,sent.text);
 assert.equal(sent.json.incomeRecorded,false);
 assert.equal(sent.json.paymentTaken,false);
 assert.equal(sent.json.status,'PendingStaffReview');
 assert.equal(f.gifts(),0,'a public submission never records income');
 assert.equal(f.constituents(),constituents,'a public submission never creates a constituent');
 assert.equal(f.row('constituents',f.donor.id).preference,preference,'a public submission never alters consent');
 assert.deepEqual(f.financial(),before);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM public_giving_submissions').get().n,1);
 assert.equal(f.db.prepare('SELECT tenant_id FROM public_giving_submissions').get().tenant_id,f.tenantId,'submissions are tenant scoped');
 assert.equal(sent.headers.getSetCookie().length,0,'the public surface issues no session cookie');
 // Replay defence: the exact request is absorbed once; changed details are refused.
 const replay=await f.publicRequest('/submissions',{method:'POST',body});
 assert.equal(replay.status,201,replay.text);assert.equal(replay.json.replayed,true);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM public_giving_submissions').get().n,1);
 const drift=await f.publicRequest('/submissions',{method:'POST',body:{...body,amountCents:9999}});
 assert.equal(drift.status,409,drift.text);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM public_giving_submissions').get().n,1);
 assert.throws(()=>f.db.prepare('DELETE FROM public_giving_submissions').run(),/retained/);
});

test('the public surface enforces its own origin, fetch-site and referer checks',async t=>{
 const f=await fixture(t);
 assert.equal((await f.publicRequest('/status',{headers:{Origin:ALLOWED}})).status,200,'the explicitly allowed origin is accepted');
 assert.equal((await f.publicRequest('/status',{headers:{Origin:WORKSPACE_ONLY}})).status,403,'an origin this module does not allow is refused even when the workspace allows it');
 assert.equal((await f.publicRequest('/status',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal((await f.publicRequest('/status',{headers:{Referer:'https://unrelated.example/page'}})).status,403);
 assert.equal((await f.publicRequest('/status',{headers:{'Sec-Fetch-Site':'same-origin'}})).status,200);
 const before=f.financial();
 assert.equal((await f.publicRequest('/submissions',{method:'POST',body:f.submission(),headers:{Origin:WORKSPACE_ONLY}})).status,403);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM public_giving_submissions').get().n,0);
 assert.deepEqual(f.financial(),before);
});

test('the public surface bounds body size and rate, and abuse never reaches the workspace',async t=>{
 const f=await fixture(t);
 const oversized=await f.publicRequest('/submissions',{method:'POST',body:f.submission({message:'x'.repeat(5000)})});
 assert.ok([400,413].includes(oversized.status),oversized.text);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM public_giving_submissions').get().n,0);
 const statuses=[];
 for(let i=0;i<8;i++)statuses.push((await f.publicRequest('/submissions',{method:'POST',body:f.submission()})).status);
 assert.ok(statuses.includes(429),'repeated submissions are rate limited: '+statuses.join(','));
 assert.ok(f.db.prepare('SELECT COUNT(*) n FROM public_giving_submissions').get().n<=5,'the retained submission count respects the window');
 const flood=[];
 for(let i=0;i<40;i++)flood.push((await f.publicRequest('/status')).status);
 assert.ok(flood.includes(429),'general public requests are rate limited');
 assert.equal(f.gifts(),0);
});

test('a browser return or unpaid callback records no income under any outcome',async t=>{
 const f=await fixture(t);
 const before=f.financial();
 for(const outcome of ['returned','cancelled','unpaid','failed']){
  const r=await f.publicRequest('/return?outcome='+outcome+'&reference=cs_test_synthetic');
  assert.equal(r.status,200,r.text);
  assert.equal(r.json.incomeRecorded,false);
  assert.equal(r.json.giftRecorded,false);
  assert.equal(r.json.paymentVerified,false);
  assert.equal(f.gifts(),0,outcome+' must record no income');
 }
 assert.deepEqual(f.financial(),before);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM public_giving_returns WHERE income_recorded=0').get().n,4);
 assert.throws(()=>f.db.prepare('UPDATE public_giving_returns SET income_recorded=1').run(),/immutable|CHECK/);
});

test('repeated anonymous returns cannot grow retained evidence without bound or destroy the backup capability',async t=>{
 const f=await fixture(t);
 const rows=()=>f.db.prepare('SELECT COUNT(*) n FROM public_giving_returns').get().n;
 const auditRows=()=>f.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='record_public_giving_return'").get().n;
 // The same browser return repeated is idempotent: one retained row, one audit row.
 for(let i=0;i<12;i++){
  const r=await f.publicRequest('/return?outcome=returned&reference=cs_test_same');
  assert.equal(r.status,200,r.text);
  assert.equal(r.json.incomeRecorded,false,'a repeated return still records no income');
 }
 assert.equal(rows(),1,'repeats collapse to one retained row');
 assert.equal(auditRows(),1,'the append-only audit is written once, not per request');
 // Each distinct outcome for one reference is its own fact, and stays bounded.
 for(const outcome of ['cancelled','unpaid','failed'])await f.publicRequest('/return?outcome='+outcome+'&reference=cs_test_same');
 assert.equal(rows(),4);
 // The rows are append-only by design, so nothing can trim them afterwards.
 assert.throws(()=>f.db.prepare('DELETE FROM public_giving_returns').run(),/retained/);
 assert.throws(()=>f.db.prepare('UPDATE public_giving_returns SET outcome=?').run('returned'),/immutable/);
 // A caller rotating the reference cannot defeat the bound, because the bound is a
 // ceiling rather than the uniqueness constraint.
 const at=new Date(f.now).toISOString(),insert=f.db.prepare('INSERT INTO public_giving_returns VALUES(?,?,?,?,0,?)');
 for(let i=rows();i<5000;i++)insert.run(randomUUID(),f.tenantId,'filler-'+i,'returned',at);
 assert.equal(rows(),5000);
 const before=rows();
 for(let i=0;i<5;i++){
  const r=await f.publicRequest('/return?outcome=returned&reference=overflow-'+i);
  assert.equal(r.status,200,'the browser is still told the truth at the ceiling');
  assert.equal(r.json.incomeRecorded,false);
  assert.equal(r.json.paymentVerified,false);
  assert.equal(r.json.evidenceRetained,false,'the response never claims retention it did not perform');
 }
 assert.equal(rows(),before,'the ceiling holds against a rotating reference');
 // The table stays far inside the 500,000-row archive limit, so a backup is still possible.
 assert.ok(rows()<500000/10,'retained returns stay well within the backup row limit');
 const {BACKUP_LIMITS}=await import('../server/backup.js');
 const total=f.db.prepare("SELECT SUM(n) t FROM (SELECT COUNT(*) n FROM public_giving_returns UNION ALL SELECT COUNT(*) FROM public_giving_submissions UNION ALL SELECT COUNT(*) FROM audit)").get().t;
 assert.ok(total<BACKUP_LIMITS.maxRows,'the workspace can still produce a recovery archive: '+total+' < '+BACKUP_LIMITS.maxRows);
});

test('an over-long or unsupported return reference is refused rather than retained',async t=>{
 const f=await fixture(t);
 for(const reference of ['x'.repeat(300),'has spaces','<script>','"quoted"'])
  assert.equal((await f.publicRequest('/return?reference='+encodeURIComponent(reference))).status,400,reference.slice(0,20));
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM public_giving_returns').get().n,0);
});

test('donor self-service is strictly bounded to one signed intention and exposes no other donor',async t=>{
 const f=await fixture(t);
 const first=await f.intention(),second=await f.intention();
 const link=await f.donorLink(first);
 assert.ok(link.token);
 assert.match(link.delivery,/Not sent/);
 assert.equal(f.db.prepare('SELECT token_hash FROM recurring_intentions WHERE id=?').get(first.id).token_hash.length,64,'only the token hash is retained');
 assert.ok(!f.db.prepare('SELECT token_hash FROM recurring_intentions WHERE id=?').get(first.id).token_hash.includes(link.token));
 const view=await f.publicRequest('/self-service/view',{method:'POST',body:{token:link.token}});
 assert.equal(view.status,200,view.text);
 const shown=view.json.intention;
 assert.equal(shown.id,first.id);
 assert.equal(shown.amountCents,10001);
 assert.equal(shown.designationName,f.fund.name);
 // Strict bounds: no donor identity, no other intention, no constituent browsing.
 for(const forbidden of ['donorName','donorId','campaignId','campaignName','collections','sourceVersions','requestId'])
  assert.equal(forbidden in shown,false,'donor self-service must not expose '+forbidden);
 assert.equal(JSON.stringify(view.json).includes(second.id),false,'one link never reveals another intention');
 assert.equal(JSON.stringify(view.json).includes(f.donor.name),false,'one link never reveals constituent identity');
 assert.equal(view.headers.getSetCookie().length,0);
 // Only one link exists per intention, and a second issue is refused.
 const again=await f.request('/recurring-giving/intentions/'+first.id+'/donor-link',{method:'POST',session:f.admin,body:{version:first.version+1,reason:'Second link attempt',expiresInDays:30}});
 assert.ok([409].includes(again.status),again.text);
});

test('a donor reloading their own link succeeds and retains at most one use row per action',async t=>{
 const f=await fixture(t);
 const i=await f.intention(),link=await f.donorLink(i);
 for(let attempt=0;attempt<4;attempt++){
  const view=await f.publicRequest('/self-service/view',{method:'POST',body:{token:link.token}});
  assert.equal(view.status,200,'reloading a valid link must not fail: '+view.text);
  assert.equal(view.json.intention.id,i.id);
 }
 const use=f.db.prepare("SELECT * FROM public_giving_token_uses WHERE action='view'").all();
 assert.equal(use.length,1,'one signed link retains one view row however often it is opened');
 // Prove the row really was written under a live uniqueness constraint, so this test
 // cannot pass merely because the use was never recorded at all.
 assert.throws(()=>f.db.prepare('INSERT INTO public_giving_token_uses VALUES(?,?,?,?,?,?)').run(randomUUID(),f.tenantId,use[0].token_hash,'view',use[0].nonce,use[0].at),/UNIQUE|constraint/i);
 assert.equal(f.gifts(),0);
});

test('an unsigned, foreign-tenant, foreign-secret or expired donor link is refused and changes nothing',async t=>{
 const f=await fixture(t);
 const i=await f.intention(),link=await f.donorLink(i);
 const before=f.db.prepare('SELECT * FROM recurring_intentions WHERE id=?').get(i.id);
 const rejects=[
  ['garbage',       'not-a-token-value-but-long-enough-to-pass-length-check'],
  ['altered',       link.token.slice(0,-1)+(link.token.at(-1)==='a'?'b':'a')],
  ['foreign tenant',mintToken({tenantId:randomUUID(),intentionId:i.id,expiresAt:f.now+86400000})],
  ['foreign secret',mintToken({secret:'a-totally-different-signing-secret',tenantId:f.tenantId,intentionId:i.id,expiresAt:f.now+86400000})],
  ['expired',       mintToken({tenantId:f.tenantId,intentionId:i.id,expiresAt:f.now-1000})]
 ];
 for(const [label,token] of rejects){
  const view=await f.publicRequest('/self-service/view',{method:'POST',body:{token}});
  assert.ok([400,403,404].includes(view.status),label+' → '+view.text);
  const cancel=await f.publicRequest('/self-service/cancel',{method:'POST',body:{token,version:i.version,reason:'Attempted'}});
  assert.ok([400,403,404,429].includes(cancel.status),label+' cancel → '+cancel.text);
 }
 assert.deepEqual(f.db.prepare('SELECT * FROM recurring_intentions WHERE id=?').get(i.id),before,'refused links change nothing');
 // A validly signed token for an intention that never bound it resolves to nothing.
 const unbound=mintToken({tenantId:f.tenantId,intentionId:randomUUID(),expiresAt:f.now+86400000});
 assert.equal((await f.publicRequest('/self-service/view',{method:'POST',body:{token:unbound}})).status,404);
});

test('a donor cancels only their own intention, keeps posted gifts and never changes consent',async t=>{
 const f=await fixture(t);
 const i=await f.intention(),other=await f.intention();
 const collected=await f.request('/recurring-giving/collections/'+i.collections[0].id+'/collect',{method:'POST',session:f.admin,body:{version:i.collections[0].version,reason:'Reviewed simulated collection',testModeConfirmed:true}});
 assert.equal(collected.status,200,collected.text);
 const posted=await f.request('/recurring-giving/collections/'+collected.json.collection.id+'/record-gift',{method:'POST',session:f.admin,body:{version:collected.json.collection.version,donorVersion:f.row('constituents',f.donor.id).version,campaignVersion:f.row('campaigns',f.campaign.id).version,designationVersion:f.row('designations',f.fund.id).version,reason:'Explicit reviewed settlement',reviewConfirmed:true}});
 assert.equal(posted.status,201,posted.text);
 const link=await f.donorLink((await f.request('/recurring-giving/intentions/'+i.id,{session:f.admin})).json.intention);
 const before=f.financial(),preference=f.row('constituents',f.donor.id).preference;
 const current=(await f.publicRequest('/self-service/view',{method:'POST',body:{token:link.token}})).json.intention;
 const stale=await f.publicRequest('/self-service/cancel',{method:'POST',body:{token:link.token,version:current.version+5,reason:'Stale attempt'}});
 assert.equal(stale.status,409,stale.text);
 const cancelled=await f.publicRequest('/self-service/cancel',{method:'POST',body:{token:link.token,version:current.version,reason:'No longer able to give'}});
 assert.equal(cancelled.status,200,cancelled.text);
 assert.equal(cancelled.json.intention.status,'Cancelled');
 assert.equal(cancelled.json.consentChanged,false);
 assert.equal(cancelled.json.financialHistoryChanged,false);
 assert.deepEqual(f.financial(),before,'a donor cancellation never rewrites financial history');
 assert.equal(f.row('gifts',posted.json.giftId).status,'Posted');
 assert.equal(f.row('constituents',f.donor.id).preference,preference,'a donor cancellation never alters consent');
 assert.equal(f.db.prepare('SELECT status FROM recurring_intentions WHERE id=?').get(other.id).status,'Active','only the linked intention is cancelled');
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='donor_cancel_recurring_intention'").get().n,1,'the donor action is retained in the audit');
 const repeat=await f.publicRequest('/self-service/cancel',{method:'POST',body:{token:link.token,version:cancelled.json.intention.version,reason:'Again'}});
 assert.equal(repeat.status,409,repeat.text);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM public_giving_token_uses').get().n>=2,true,'token use is retained for review');
});

test('the public surface never exposes a workspace endpoint or an unknown path',async t=>{
 const f=await fixture(t);
 for(const path of ['/intentions','/self-service','/unknown'])
  assert.ok([400,403,404].includes((await f.publicRequest(path)).status),path);
 // Traversal cannot escape the public prefix: it normalizes to the authenticated
 // workspace, which still refuses an unauthenticated caller.
 assert.equal((await f.publicRequest('/../../records/constituents')).status,401);
 assert.equal((await f.request('/records/constituents',{session:null})).status,401,'the workspace still requires authentication');
 assert.equal((await f.request('/recurring-giving/intentions',{session:null})).status,401);
});
