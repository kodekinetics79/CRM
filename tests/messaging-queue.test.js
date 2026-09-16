import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';
import {createTestOnlyMessagingTransport,QUEUE_PURPOSES} from '../server/messaging.js';

const TENANT='55555555-5555-4555-8555-555555555555';
const SECRET='synthetic-messaging-callback-secret-key-0001';

async function fixture(t,{enabled=true,rateLimitPerMinute=60}={}){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-messaging-queue-'));
 let app,server,base,time=Date.parse('2026-09-14T12:00:00.000Z');
 const transport=createTestOnlyMessagingTransport();
 const outbound=[],realFetch=globalThis.fetch;
 globalThis.fetch=(input,init)=>{outbound.push(String(input?.url||input));return realFetch(input,init);};
 const options=()=>({clock:()=>time,...(enabled?{mode:'TEST_ONLY',channels:['Email','SMS'],fromAddress:'notices@foundation.example',fromNumber:'+15125550100',webhookSecret:SECRET,authorization:{approved:true,reference:'Synthetic TEST_ONLY authorization',reviewedAt:'2026-09-13T00:00:00.000Z'},rateLimitPerMinute,maxRecipients:50,transport}:{})});
 async function open(){app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true,mfaKey:'',tenantId:TENANT,extensions:{messaging:options()}});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{globalThis.fetch=realFetch;await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(session){headers.Cookie=session.cookie;if(csrf)headers['X-CSRF-Token']=session.csrfToken;}const r=await fetch(base+'/api'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,json:await r.json()};}
 async function login(email='alex@foundation.example'){const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'FoundationDemo!2026'})});assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};}
 let admin=await login(),staff=await login('staff@foundation.example');
 async function person(name,changes={}){const r=await request('/records/constituents',{method:'POST',session:staff,body:{name,type:'Individual',email:name.toLowerCase().replace(/[^a-z]/g,'')+'@example.test',phone:'+1512555'+String(1000+name.length).slice(-4),preference:'Email',...changes}});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.record;}
 const service=()=>app.locals.extensions.services.messaging;
 // Callers queue inside their own BEGIN IMMEDIATE write transaction.
 function queue(envelope,{commit=true}={}){
  const db=app.locals.db;db.exec('BEGIN IMMEDIATE');
  try{const result=service().queueTransactional(envelope);db.exec(commit?'COMMIT':'ROLLBACK');return result;}
  catch(e){db.exec('ROLLBACK');throw e;}
 }
 const envelope=(p,changes={})=>({purpose:'volunteer-shift-reminder',constituentId:p.id,constituentVersion:p.version,channel:'Email',reference:'shift-'+p.id.slice(0,8)+'-1',summary:'Your shift starts at 9:00 on Saturday.',...changes});
 async function consent(p,{channel='Email',purpose='Marketing',state='Granted'}={}){return request('/messaging/consent',{method:'POST',session:staff,body:{constituentId:p.id,constituentVersion:p.version,channel,purpose,state,basis:'Synthetic recorded consent evidence',confirmed:true}});}
 async function suppress(p,channel='Email'){return request('/messaging/suppressions',{method:'POST',session:staff,body:{constituentId:p.id,channel,reason:'Manual',basis:'Synthetic retained denial',confirmed:true}});}
 async function runQueue(session=admin){return request('/messaging/queue/execute',{method:'POST',session,body:{reason:'Reviewed operational reminder run',confirmed:true}});}
 return {request,queue,envelope,person,consent,suppress,runQueue,service,transport,outbound,
  get admin(){return admin;},get staff(){return staff;},advance:ms=>{time+=ms;},
  restart:async()=>{await close();await open();admin=await login();staff=await login('staff@foundation.example');},
  get db(){return app.locals.db;}};
}

test('a queued operational reminder is accepted synchronously, performs no network call and never reads as delivered',async t=>{
 const f=await fixture(t),volunteer=await f.person('Queued Volunteer');
 const before=f.outbound.length;
 const result=f.queue(f.envelope(volunteer));
 assert.deepEqual(Object.keys(result).sort(),['accepted','classification','delivery','queueId','reference']);
 assert.equal(result.accepted,true);
 assert.equal(result.classification,'Transactional');
 assert.equal(result.delivery,'Not sent');
 assert.equal(result.reference,'shift-'+volunteer.id.slice(0,8)+'-1');
 assert.equal(f.outbound.length,before,'queueing performs no network I/O');
 assert.equal(f.transport.sent.length,0,'queueing never calls the transport');
 const row=f.db.prepare('SELECT * FROM messaging_queue').get();
 assert.equal(row.status,'Queued');
 assert.equal(row.classification,'Transactional');
 assert.equal(row.consent_basis,'Operational relationship recorded by the requesting service');
 const listed=(await f.request('/messaging/queue',{session:f.staff})).json;
 assert.equal(listed.queue.length,1);
 assert.equal(listed.queue[0].status,'Queued');
 assert.equal(listed.queue[0].delivery,'Not sent');
 assert.equal(listed.classification,'Transactional');
 assert.match(listed.statement,/never a sent or delivered message/);
 await f.restart();
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM messaging_queue WHERE status='Queued'").get().n,1,'the queue is durable');
});

test('an operational reminder needs no marketing consent and a marketing unsubscribe never blocks it',async t=>{
 const f=await fixture(t),volunteer=await f.person('Unsubscribed Volunteer');
 // A marketing-scope denial: the volunteer opted out of fundraising email.
 f.db.prepare("INSERT INTO messaging_suppressions VALUES(?,?,?,?,?,?,?,?,?)").run('sup-1',TENANT,'Email',volunteer.email,'Unsubscribed','Marketing','Provider callback','synthetic','2026-09-14T11:00:00.000Z');
 const queued=f.queue(f.envelope(volunteer));
 assert.equal(queued.accepted,true,'a marketing unsubscribe must never strand an operational reminder');
 const run=await f.runQueue();
 assert.equal(run.status,200,JSON.stringify(run.json));
 assert.equal(run.json.sent,1);
 assert.equal(f.transport.sent.length,1);
 assert.equal(f.transport.sent[0].classification,'Transactional');
 assert.equal(f.transport.sent[0].purpose,'volunteer-shift-reminder');
 assert.equal(f.transport.sent[0].campaignId,undefined,'an operational reminder is never a campaign send');
 assert.match(f.transport.sent[0].body,/not a fundraising message/);
 // The same person still cannot be reviewed into a marketing campaign.
 const template=(await f.request('/correspondence/templates',{method:'POST',session:f.staff,body:{name:'Reviewed messaging',kind:'Messaging',subject:'News {{recipientName}}',body:'Hello {{recipientName}} from {{organizationName}}.'}})).json.template;
 assert.equal((await f.consent(volunteer,{purpose:'Marketing'})).status,201);
 const campaign=(await f.request('/messaging/campaigns',{method:'POST',session:f.staff,body:{name:'Appeal',classification:'Marketing',channel:'Email',templateId:template.id,templateVersion:1,reason:'Reviewed appeal',confirmed:true}})).json.campaign;
 const review=await f.request('/messaging/campaigns/'+campaign.id+'/review',{method:'POST',session:f.staff,body:{version:1,constituentIds:[volunteer.id],reason:'Attempt marketing to an unsubscribed volunteer',confirmed:true}});
 assert.equal(review.status,409,'the marketing unsubscribe still refuses a marketing send');
 assert.match(review.json.error,/Retained suppression/);
});

test('an All-scope suppression and Do not contact refuse the queue call without failing the caller',async t=>{
 const f=await fixture(t),complained=await f.person('Complaining Volunteer'),blocked=await f.person('Blocked Volunteer',{preference:'Do not contact'}),gone=await f.person('No Address Volunteer',{email:''});
 assert.equal((await f.suppress(complained)).status,201);
 for(const [subject,pattern] of [[complained,/Retained suppression/],[blocked,/Do not contact/],[gone,/No valid Email address/]]){
  const result=f.queue(f.envelope(subject));
  assert.equal(result.accepted,false,'a policy denial is a refusal, never a throw');
  assert.match(result.reason,pattern);
  assert.equal(result.reference,undefined);
 }
 const stale=f.queue(f.envelope(complained,{constituentVersion:99,reference:'stale-read'}));
 assert.equal(stale.accepted,false);assert.match(stale.reason,/changed since it was read/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_queue').get().n,0,'a refused reminder queues nothing');
 assert.equal(f.transport.sent.length,0);
 assert.equal((await f.request('/messaging/report',{session:f.admin})).json.transactionalQueue.queued,0);
});

test('malformed envelopes and unknown purposes are programmer errors that throw',async t=>{
 const f=await fixture(t),volunteer=await f.person('Strict Volunteer');
 for(const changes of [{purpose:'marketing-blast'},{purpose:'unknown'},{channel:'Fax'},{summary:''},{reference:''},{constituentVersion:0},{extra:true}])
  assert.throws(()=>f.queue(f.envelope(volunteer,changes)),'malformed input throws rather than silently refusing');
 assert.throws(()=>f.service().queueTransactional(f.envelope(volunteer)),/write transaction/,'queueing outside the caller transaction is programmer error');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_queue').get().n,0);
 assert.deepEqual([...QUEUE_PURPOSES],(await f.request('/messaging/status',{session:f.staff})).json.queuePurposes);
});

test('a rolled back caller transaction leaves no queued reminder, and one reference queues exactly once',async t=>{
 const f=await fixture(t),volunteer=await f.person('Atomic Volunteer');
 const abandoned=f.queue(f.envelope(volunteer),{commit:false});
 assert.equal(abandoned.accepted,true);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_queue').get().n,0,'the reminder commits only with the caller action');
 const first=f.queue(f.envelope(volunteer));
 const replay=f.queue(f.envelope(volunteer));
 assert.equal(replay.accepted,true);assert.equal(replay.replayed,true);assert.equal(replay.queueId,first.queueId);
 const conflict=f.queue(f.envelope(volunteer,{summary:'A different operational summary.'}));
 assert.equal(conflict.accepted,false);assert.match(conflict.reason,/already queued for a different/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_queue').get().n,1);
 const run=await f.runQueue();
 assert.equal(run.json.sent,1);
 assert.equal((await f.runQueue()).json.sent,0,'a handed-off reminder is never handed off twice');
 assert.equal(f.transport.sent.length,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_queue_deliveries').get().n,1);
 assert.throws(()=>f.db.prepare('DELETE FROM messaging_queue_deliveries').run(),/retained/i);
 assert.throws(()=>f.db.prepare("UPDATE messaging_queue SET summary='tamper'").run(),/immutable/i);
});

test('transactional reminders are never counted, listed or executed as marketing',async t=>{
 const f=await fixture(t),donor=await f.person('Marketing Donor'),volunteer=await f.person('Operational Volunteer');
 const template=(await f.request('/correspondence/templates',{method:'POST',session:f.staff,body:{name:'Reviewed messaging',kind:'Messaging',subject:'News {{recipientName}}',body:'Hello {{recipientName}} from {{organizationName}}.'}})).json.template;
 assert.equal((await f.consent(donor,{purpose:'Marketing'})).status,201);
 const campaign=(await f.request('/messaging/campaigns',{method:'POST',session:f.staff,body:{name:'Autumn appeal',classification:'Marketing',channel:'Email',templateId:template.id,templateVersion:1,reason:'Reviewed appeal',confirmed:true}})).json.campaign;
 const reviewed=(await f.request('/messaging/campaigns/'+campaign.id+'/review',{method:'POST',session:f.staff,body:{version:1,constituentIds:[donor.id],reason:'Reviewed consented donor',confirmed:true}})).json.campaign;
 const executed=await f.request('/messaging/campaigns/'+campaign.id+'/execute',{method:'POST',session:f.admin,body:{version:reviewed.version,snapshotDigest:reviewed.snapshotDigest,idempotencyKey:globalThis.crypto.randomUUID(),reason:'Reviewed execution',confirmed:true}});
 assert.equal(executed.status,200,JSON.stringify(executed.json));
 for(const suffix of ['-1','-2'])assert.equal(f.queue(f.envelope(volunteer,{reference:'shift'+suffix})).accepted,true);
 assert.equal((await f.runQueue()).json.sent,2);
 const report=(await f.request('/messaging/report',{session:f.admin})).json;
 assert.equal(report.campaigns.length,1);
 assert.equal(report.campaigns[0].classification,'Marketing');
 assert.equal(report.campaigns[0].recipientCount,1);
 assert.equal(report.campaigns[0].handedToTransport,1,'operational reminders never inflate a marketing campaign count');
 assert.equal(report.transactionalQueue.handedToTransport,2);
 assert.equal(report.transactionalQueue.classification,'Transactional');
 assert.equal(report.transactionalQueue.byPurpose['volunteer-shift-reminder'],2);
 assert.match(report.transactionalQueue.statement,/never included in any campaign or marketing count/);
 assert.equal((await f.request('/messaging/campaigns',{session:f.staff})).json.campaigns.length,1,'a queued reminder is never a campaign');
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM messaging_recipients WHERE constituent_id=?").get(volunteer.id).n,0);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM messaging_queue WHERE classification<>'Transactional'").get().n,0);
 assert.throws(()=>f.db.prepare("INSERT INTO messaging_queue VALUES('x',?,'task-reminder','Marketing',?,1,'Email','r','s','b',NULL,'system','Queued',0,'2026-09-14T12:00:00.000Z',0,NULL,NULL,'2026-09-14T12:00:00.000Z','2026-09-14T12:00:00.000Z')").run(TENANT,volunteer.id),/CHECK|constraint/i,'the queue table cannot hold a marketing row');
});

test('policy is rechecked at execution: the address is resolved late and a new denial refuses the handoff',async t=>{
 const f=await fixture(t),moving=await f.person('Moving Volunteer'),denied=await f.person('Denied Volunteer');
 assert.equal(f.queue(f.envelope(moving,{reference:'moving-1'})).accepted,true);
 assert.equal(f.queue(f.envelope(denied,{reference:'denied-1'})).accepted,true);
 const edit=await f.request('/records/constituents/'+moving.id,{method:'PATCH',session:f.staff,body:{version:moving.version,name:moving.name,type:'Individual',email:'moved@example.test',phone:moving.phone,preference:'Email'}});
 assert.equal(edit.status,200,JSON.stringify(edit.json));
 assert.equal((await f.suppress(denied)).status,201);
 const run=await f.runQueue();
 assert.equal(run.status,200,JSON.stringify(run.json));
 assert.equal(run.json.sent,1);
 assert.equal(run.json.refused,1);
 assert.equal(f.transport.sent.length,1);
 assert.equal(f.transport.sent[0].to,'moved@example.test','the address is resolved at execution, not frozen at queue time');
 const rows=f.db.prepare('SELECT reference,status,last_error FROM messaging_queue ORDER BY reference').all();
 assert.deepEqual(rows.map(r=>[r.reference,r.status]),[['denied-1','Refused'],['moving-1','Sent']]);
 assert.match(rows[0].last_error,/Retained suppression/);
 const audited=f.db.prepare("SELECT details FROM audit WHERE action='send_transactional_message'").get().details;
 assert.match(audited,/"marketing":false/);
 assert.match(audited,/"providerTransmitted":false/);
 assert.doesNotMatch(audited,/moved@example\.test/);
});

test('with no configured transport queueing still succeeds and only execution refuses',async t=>{
 const f=await fixture(t,{enabled:false}),volunteer=await f.person('Unconfigured Volunteer');
 const queued=f.queue(f.envelope(volunteer));
 assert.equal(queued.accepted,true,'a durable internal queue does not depend on transport configuration');
 assert.equal(queued.delivery,'Not sent');
 const run=await f.runQueue();
 assert.equal(run.status,503);
 assert.match(run.json.error,/No messaging transport is configured/);
 assert.equal(f.transport.sent.length,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_queue_deliveries').get().n,0);
 const report=(await f.request('/messaging/report',{session:f.admin})).json;
 assert.equal(report.transactionalQueue.queued,1);
 assert.equal(report.transactionalQueue.handedToTransport,0);
 assert.equal(report.transactionalQueue.mode,'Disabled');
 assert.equal((await f.request('/messaging/status',{session:f.staff})).json.queueingEnabled,true);
});

test('the queue shares the transport rate budget and only an administrator may run it',async t=>{
 const f=await fixture(t,{rateLimitPerMinute:1}),volunteer=await f.person('Bounded Volunteer');
 for(const suffix of ['-1','-2'])assert.equal(f.queue(f.envelope(volunteer,{reference:'bounded'+suffix})).accepted,true);
 assert.equal((await f.runQueue(f.staff)).status,403,'executing the queue requires administrator access');
 assert.equal((await f.request('/messaging/queue/execute',{method:'POST',session:f.admin,csrf:false,body:{reason:'No CSRF',confirmed:true}})).status,403);
 assert.equal(f.transport.sent.length,0);
 const first=await f.runQueue();
 assert.equal(first.json.sent,1);
 assert.equal(first.json.pending,1);
 assert.equal(first.json.rateLimited,true);
 assert.equal((await f.runQueue()).status,429,'the shared per-minute budget is exhausted');
 f.advance(61000);
 const second=await f.runQueue();
 assert.equal(second.json.sent,1);
 assert.equal(second.json.pending,0);
 assert.equal(f.transport.sent.length,2);
});
