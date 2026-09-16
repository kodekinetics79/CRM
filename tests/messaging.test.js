import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createHmac} from 'node:crypto';
import {createApp} from '../server/app.js';
import {createTestOnlyMessagingTransport,validateMessagingConfig} from '../server/messaging.js';

const TENANT='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222';
const SECRET='synthetic-messaging-callback-secret-key-0001';
const template=(changes={})=>({name:'Reviewed messaging template',kind:'Messaging',subject:'News for {{recipientName}}',body:'Hello {{recipientName}} at {{recipientEmail}}, from {{organizationName}}.',...changes});

async function fixture(t,{rateLimitPerMinute=60,channels=['Email','SMS'],enabled=true}={}){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-messaging-'));
 let app,server,base,tenantActive=true,tenant=TENANT,time=Date.parse('2026-09-14T12:00:00.000Z');
 const transport=createTestOnlyMessagingTransport();
 const outbound=[],realFetch=globalThis.fetch;
 globalThis.fetch=(input,init)=>{outbound.push(String(input?.url||input));return realFetch(input,init);};
 const options=()=>({clock:()=>time,...(enabled?{mode:'TEST_ONLY',channels,fromAddress:'news@foundation.example',fromNumber:'+15125550100',webhookSecret:SECRET,authorization:{approved:true,reference:'Synthetic TEST_ONLY authorization',reviewedAt:'2026-09-13T00:00:00.000Z'},rateLimitPerMinute,maxRecipients:50,transport}:{})});
 async function open(){app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true,mfaKey:'',tenantId:tenant,isTenantActive:()=>tenantActive,extensions:{messaging:options()}});server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{globalThis.fetch=realFetch;await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(session){headers.Cookie=session.cookie;if(csrf)headers['X-CSRF-Token']=csrf===true?session.csrfToken:csrf;}const r=await fetch(base+'/api'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,json:await r.json()};}
 async function login(email='alex@foundation.example'){const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'FoundationDemo!2026'})});assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};}
 let admin=await login(),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 async function person(name,changes={}){const r=await request('/records/constituents',{method:'POST',session:staff,body:{name,type:'Individual',email:name.toLowerCase().replace(/[^a-z]/g,'')+'@example.test',phone:'+1512555'+String(1000+name.length).slice(-4),preference:'Email',...changes}});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.record;}
 async function messagingTemplate(changes={}){const r=await request('/correspondence/templates',{method:'POST',session:staff,body:template(changes)});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.template;}
 async function consent(p,{channel='Email',purpose='Marketing',state='Granted',session=staff}={}){return request('/messaging/consent',{method:'POST',session,body:{constituentId:p.id,constituentVersion:p.version,channel,purpose,state,basis:'Synthetic recorded consent evidence',confirmed:true}});}
 async function campaign(tpl,changes={},session=staff){const r=await request('/messaging/campaigns',{method:'POST',session,body:{name:'Reviewed synthetic campaign',classification:'Marketing',channel:'Email',templateId:tpl.id,templateVersion:tpl.version,reason:'Synthetic reviewed campaign',confirmed:true,...changes}});return r;}
 async function review(c,ids,session=staff,changes={}){return request('/messaging/campaigns/'+c.id+'/review',{method:'POST',session,body:{version:c.version,constituentIds:ids,reason:'Reviewed explicit recipients and consent',confirmed:true,...changes}});}
 async function execute(c,session=admin,changes={}){return request('/messaging/campaigns/'+c.id+'/execute',{method:'POST',session,body:{version:c.version,snapshotDigest:c.snapshotDigest,idempotencyKey:changes.idempotencyKey||globalThis.crypto.randomUUID(),reason:'Reviewed execution against the TEST_ONLY transport',confirmed:true,...changes}});}
 const detail=(id,session=staff)=>request('/messaging/campaigns/'+id,{session});
 const sign=payload=>{const stamp=Math.floor(time/1000);return 't='+stamp+',v1='+createHmac('sha256',SECRET).update(String(stamp)+'.').update(Buffer.from(payload,'utf8')).digest('hex');};
 async function intake(event,session=admin,secret=SECRET){const payload=JSON.stringify({tenantId:tenant,...event}),stamp=Math.floor(time/1000);const signature='t='+stamp+',v1='+createHmac('sha256',secret).update(String(stamp)+'.').update(Buffer.from(payload,'utf8')).digest('hex');return request('/messaging/events/intake',{method:'POST',session,body:{signature,payload}});}
 return {request,login,get admin(){return admin;},get staff(){return staff;},get viewer(){return viewer;},person,messagingTemplate,consent,campaign,review,execute,detail,sign,intake,transport,outbound,
  advance:ms=>{time+=ms;},suspend:()=>{tenantActive=false;},resume:()=>{tenantActive=true;},
  restart:async()=>{await close();await open();admin=await login();staff=await login('staff@foundation.example');viewer=await login('board@foundation.example');},
  switchTenant:async(next=OTHER)=>{await close();tenant=next;await open();admin=await login();staff=await login('staff@foundation.example');},
  get db(){return app.locals.db;}};
}
async function reviewedCampaign(f,{classification='Marketing',channel='Email',people=null}={}){
 const tpl=await f.messagingTemplate(),recipients=people||[await f.person('Reviewed Recipient')];
 for(const p of recipients)assert.equal((await f.consent(p,{purpose:classification==='Marketing'?'Marketing':'Transactional',channel})).status,201);
 const created=await f.campaign(tpl,{classification,channel});assert.equal(created.status,201,JSON.stringify(created.json));
 const reviewed=await f.review(created.json.campaign,recipients.map(p=>p.id));assert.equal(reviewed.status,200,JSON.stringify(reviewed.json));
 return {template:tpl,recipients,campaign:reviewed.json.campaign};
}

test('messaging refuses every production transport and only accepts an explicitly authorized injected TEST_ONLY transport',()=>{
 const transport=createTestOnlyMessagingTransport();
 const good={mode:'TEST_ONLY',channels:['Email'],fromAddress:'news@foundation.example',webhookSecret:SECRET,authorization:{approved:true,reference:'Reviewed',reviewedAt:'2026-09-13T00:00:00.000Z'},transport};
 assert.equal(validateMessagingConfig(null),null);
 assert.equal(validateMessagingConfig({clock:Date.now}),null);
 assert.equal(validateMessagingConfig(good).mode,'TEST_ONLY');
 assert.throws(()=>validateMessagingConfig(good,{production:true}),/production/i);
 for(const bad of [{...good,mode:'LIVE'},{...good,transport:undefined},{...good,transport:{mode:'LIVE',send(){}}},{...good,transport:{mode:'TEST_ONLY'}},{...good,authorization:{...good.authorization,approved:false}},{...good,channels:['SMS'],fromNumber:undefined},{...good,apiKey:'live'}])assert.throws(()=>validateMessagingConfig(bad));
});

test('allowed roles review and execute; viewers and staff are refused the execution authority they do not hold',async t=>{
 const f=await fixture(t),{campaign}=await reviewedCampaign(f);
 assert.equal((await f.request('/messaging/campaigns')).status,401);
 assert.equal((await f.request('/messaging/campaigns',{session:f.viewer})).status,403);
 assert.equal((await f.request('/messaging/report',{session:f.staff})).status,403);
 assert.equal((await f.execute(campaign,f.staff)).status,403);
 assert.equal((await f.execute(campaign,f.viewer)).status,403);
 assert.equal((await f.request('/messaging/campaigns/'+campaign.id+'/execute',{method:'POST',session:f.admin,csrf:false,body:{version:campaign.version,snapshotDigest:campaign.snapshotDigest,idempotencyKey:globalThis.crypto.randomUUID(),reason:'No CSRF',confirmed:true}})).status,403);
 assert.equal(f.transport.sent.length,0);
 const done=await f.execute(campaign);assert.equal(done.status,200,JSON.stringify(done.json));
 assert.equal(done.json.sent,1);assert.equal(done.json.campaign.status,'Executed');
 assert.equal(f.transport.sent.length,1);
 assert.equal(f.transport.sent[0].classification,'Marketing');
 assert.match(f.transport.sent[0].body,/Hello Reviewed Recipient/);
 assert.ok(f.outbound.every(url=>url.startsWith('http://127.0.0.1:')),'TEST_ONLY execution performed no external request');
 assert.equal((await f.request('/messaging/report',{session:f.admin})).json.campaigns[0].handedToTransport,1);
});

test('contact preference is not consent: an unconsented, opted-out or unaddressed recipient refuses the whole review',async t=>{
 const f=await fixture(t),tpl=await f.messagingTemplate();
 const consented=await f.person('Consented One'),bare=await f.person('No Consent'),blocked=await f.person('Blocked One',{preference:'Do not contact'}),noEmail=await f.person('No Address',{email:''});
 assert.equal((await f.consent(consented)).status,201);
 assert.equal((await f.consent(blocked)).status,409);
 const created=(await f.campaign(tpl)).json.campaign;
 for(const ids of [[bare.id],[noEmail.id],[blocked.id],[consented.id,bare.id]]){const r=await f.review(created,ids);assert.equal(r.status,409,JSON.stringify(r.json));assert.match(r.json.error,/not eligible/);}
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_recipients').get().n,0);
 const transactional=await f.request('/messaging/campaigns',{method:'POST',session:f.staff,body:{name:'Transactional notice',classification:'Transactional',channel:'Email',templateId:tpl.id,templateVersion:1,reason:'Synthetic transactional',confirmed:true}});
 assert.equal((await f.review(transactional.json.campaign,[consented.id])).status,409,'a marketing grant is not transactional consent');
 assert.equal((await f.consent(consented,{purpose:'Transactional'})).status,201);
 assert.equal((await f.review(transactional.json.campaign,[consented.id])).status,200);
 assert.equal(f.transport.sent.length,0);
});

test('suppression is sticky: no consent record, provider subscription or route clears it',async t=>{
 const f=await fixture(t),person=await f.person('Sticky Recipient');
 assert.equal((await f.consent(person)).status,201);
 const suppressed=await f.request('/messaging/suppressions',{method:'POST',session:f.staff,body:{constituentId:person.id,channel:'Email',reason:'Manual',basis:'Synthetic retained denial',confirmed:true}});
 assert.equal(suppressed.status,201);assert.equal(suppressed.json.suppression.scope,'All');
 const tpl=await f.messagingTemplate(),created=(await f.campaign(tpl)).json.campaign;
 assert.match((await f.review(created,[person.id])).json.error,/Retained suppression/);
 assert.equal((await f.consent(person,{state:'Granted'})).status,201);
 assert.match((await f.review(created,[person.id])).json.error,/Retained suppression/);
 assert.equal((await f.intake({type:'Subscribed',channel:'Email',address:person.email})).status,201);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_suppressions').get().n,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM messaging_consent_events WHERE source_kind='Provider observation' AND state='Granted'").get().n,0);
 assert.throws(()=>f.db.prepare('DELETE FROM messaging_suppressions').run(),/retained/i);
 assert.throws(()=>f.db.prepare("UPDATE messaging_suppressions SET reason='Manual',scope='Marketing'").run(),/immutable/i);
 assert.throws(()=>f.db.prepare("INSERT INTO messaging_consent_events VALUES('x',?,?,1,'Email','a@b.test','Marketing','Granted','Provider observation','forced','system','2026-09-14T12:00:00.000Z')").run(TENANT,person.id),/CHECK|constraint/i);
 await f.restart();
 assert.match((await f.review(created,[person.id],f.staff)).json.error,/Retained suppression/);
 assert.equal(f.transport.sent.length,0);
});

test('signed callbacks are replay-defended, tenant-scoped, bounded and record suppression without claiming readership',async t=>{
 const f=await fixture(t),{campaign,recipients}=await reviewedCampaign(f);
 assert.equal((await f.execute(campaign)).status,200);
 const messageId=f.db.prepare('SELECT provider_message_id p FROM messaging_deliveries').get().p;
 const payload=JSON.stringify({tenantId:TENANT,type:'Complaint',channel:'Email',address:recipients[0].email,providerMessageId:messageId});
 const first=await f.request('/messaging/events/intake',{method:'POST',session:f.admin,body:{signature:f.sign(payload),payload}});
 assert.equal(first.status,201,JSON.stringify(first.json));assert.equal(first.json.suppressionReason,'Complaint');assert.equal(first.json.replayed,false);
 const replay=await f.request('/messaging/events/intake',{method:'POST',session:f.admin,body:{signature:f.sign(payload),payload}});
 assert.equal(replay.json.replayed,true);assert.equal(replay.json.eventId,first.json.eventId);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_events').get().n,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_suppressions').get().n,1);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM messaging_consent_events WHERE state='Withdrawn' AND source_kind='Provider observation'").get().n,1,'a complaint withdraws each purpose that was actually granted');
 assert.equal(f.db.prepare("SELECT purpose FROM messaging_consent_events WHERE state='Withdrawn'").get().purpose,'Marketing');
 assert.equal((await f.request('/messaging/events/intake',{method:'POST',session:f.admin,body:{signature:'t=1,v1='+'a'.repeat(64),payload}})).status,400);
 assert.equal((await f.intake({type:'Delivered',channel:'Email',address:recipients[0].email},f.admin,'wrong-secret-wrong-secret-wrong-secret')).status,400);
 assert.equal((await f.request('/messaging/events/intake',{method:'POST',session:f.admin,body:{signature:f.sign(payload),payload:JSON.stringify({tenantId:OTHER,type:'Delivered',channel:'Email',address:recipients[0].email})}})).status,400);
 const foreign=JSON.stringify({tenantId:OTHER,type:'Delivered',channel:'Email',address:recipients[0].email});
 assert.equal((await f.request('/messaging/events/intake',{method:'POST',session:f.admin,body:{signature:f.sign(foreign),payload:foreign}})).status,404);
 assert.equal((await f.intake({type:'Delivered',channel:'Email',address:recipients[0].email},f.staff)).status,403);
 const agedPayload=JSON.stringify({tenantId:TENANT,type:'Delivered',channel:'Email',address:recipients[0].email}),agedSignature=f.sign(agedPayload);
 f.advance(600000);
 assert.equal((await f.request('/messaging/events/intake',{method:'POST',session:f.admin,body:{signature:agedSignature,payload:agedPayload}})).status,400,'a signature outside the accepted window is refused');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_events').get().n,1);
 const report=(await f.request('/messaging/report',{session:f.admin})).json;
 assert.equal(report.campaigns[0].eventCounts.Complaint,1);
 assert.doesNotMatch(JSON.stringify(report),new RegExp(recipients[0].email));
});

test('stale sources, changed consent and changed reviewing authority refuse execution instead of silently skipping',async t=>{
 const f=await fixture(t);
 const changed=await reviewedCampaign(f,{people:[await f.person('Changing Recipient')]});
 const edit=await f.request('/records/constituents/'+changed.recipients[0].id,{method:'PATCH',session:f.staff,body:{version:changed.recipients[0].version,name:'Renamed Recipient'}});
 assert.equal(edit.status,200);
 const refused=await f.execute(changed.campaign);assert.equal(refused.status,409);assert.match(refused.json.error,/Nothing was sent/);
 assert.equal(f.transport.sent.length,0);
 assert.equal((await f.detail(changed.campaign.id)).json.campaign.status,'ReviewRequired');
 const withdrawn=await reviewedCampaign(f,{people:[await f.person('Withdrawing Recipient')]});
 assert.equal((await f.consent(withdrawn.recipients[0],{state:'Withdrawn'})).status,201);
 assert.equal((await f.execute(withdrawn.campaign)).status,409);
 const authority=await reviewedCampaign(f,{people:[await f.person('Authority Recipient')]});
 f.db.prepare('UPDATE users SET version=version+1 WHERE email=?').run('staff@foundation.example');
 const stale=await f.execute(authority.campaign);assert.equal(stale.status,409);assert.match(stale.json.error,/reviewing account|authorization/i);
 assert.equal(f.transport.sent.length,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_deliveries').get().n,0);
});

test('execution is idempotent, once-only per recipient, rate limited and durable across restart',async t=>{
 const f=await fixture(t,{rateLimitPerMinute:1});
 const people=[await f.person('Rate One'),await f.person('Rate Two')];
 const {campaign}=await reviewedCampaign(f,{people});
 const key=globalThis.crypto.randomUUID();
 const first=await f.execute(campaign,f.admin,{idempotencyKey:key});
 assert.equal(first.status,200,JSON.stringify(first.json));
 assert.equal(first.json.sent,1);assert.equal(first.json.pending,1);assert.equal(first.json.rateLimited,true);
 assert.equal(first.json.campaign.status,'Executing');
 const replay=await f.execute(campaign,f.admin,{idempotencyKey:key});
 assert.equal(replay.json.replayed,true);assert.equal(replay.json.sent,1);
 assert.equal(f.transport.sent.length,1,'a replayed execution key never hands a second message to the transport');
 const partial=(await f.detail(campaign.id)).json.campaign;
 const limited=await f.execute(partial,f.admin,{idempotencyKey:globalThis.crypto.randomUUID()});
 assert.equal(limited.status,429,JSON.stringify(limited.json));
 f.advance(61000);
 await f.restart();
 const saved=(await f.detail(campaign.id)).json.campaign;
 assert.equal(saved.status,'Executing');assert.equal(saved.sentCount,1);assert.equal(saved.pendingCount,1);
 const resumed=await f.execute(saved,f.admin,{idempotencyKey:globalThis.crypto.randomUUID()});
 assert.equal(resumed.status,200,JSON.stringify(resumed.json));
 assert.equal(resumed.json.sent,1);assert.equal(resumed.json.campaign.status,'Executed');
 assert.equal(f.transport.sent.length,2);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_deliveries').get().n,2);
 assert.equal(new Set(f.db.prepare('SELECT recipient_id FROM messaging_deliveries').all().map(r=>r.recipient_id)).size,2);
 assert.throws(()=>f.db.prepare('DELETE FROM messaging_deliveries').run(),/retained/i);
});

test('a transport failure retains no delivery, schedules a bounded retry and never repeats a completed handoff',async t=>{
 const f=await fixture(t);
 const {campaign}=await reviewedCampaign(f,{people:[await f.person('Retrying Recipient')]});
 const working=f.transport.send.bind(f.transport);let broken=true;
 f.transport.send=async message=>{if(broken)throw new Error('Synthetic transport unavailable');return working(message);};
 const failed=await f.execute(campaign);
 assert.equal(failed.status,200);assert.equal(failed.json.sent,0);assert.equal(failed.json.failed,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_deliveries').get().n,0);
 const pending=f.db.prepare('SELECT * FROM messaging_recipients').get();
 assert.equal(pending.status,'Reviewed');assert.equal(pending.attempt_count,1);assert.equal(pending.write_attempted,1);
 assert.throws(()=>f.db.prepare('UPDATE messaging_recipients SET write_attempted=0').run(),/cannot be cleared/i);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM messaging_outcomes WHERE status='Retry'").get().n,1);
 broken=false;f.advance(61000);
 const current=(await f.detail(campaign.id)).json.campaign;
 const done=await f.execute(current);
 assert.equal(done.json.sent,1);assert.equal(done.json.campaign.status,'Executed');
 assert.equal(f.transport.sent.length,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_deliveries').get().n,1);
});

test('a review audit failure leaves no recipient snapshot and the campaign stays a draft',async t=>{
 const f=await fixture(t),tpl=await f.messagingTemplate(),person=await f.person('Atomic Recipient');
 assert.equal((await f.consent(person)).status,201);
 const created=(await f.campaign(tpl)).json.campaign;
 f.db.exec("CREATE TRIGGER synthetic_messaging_review_fault BEFORE INSERT ON audit WHEN NEW.action='review_messaging_campaign' BEGIN SELECT RAISE(ABORT,'Synthetic audit unavailable'); END;");
 assert.equal((await f.review(created,[person.id])).status,500);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_recipients').get().n,0);
 assert.equal(f.db.prepare('SELECT status FROM messaging_campaigns WHERE id=?').get(created.id).status,'Draft');
 f.db.exec('DROP TRIGGER synthetic_messaging_review_fault');
 assert.equal((await f.review(created,[person.id])).status,200);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_recipients').get().n,1);
});

test('retained messaging history is auditable, protects identities and never records addresses or wording in the audit',async t=>{
 const f=await fixture(t),{campaign,recipients}=await reviewedCampaign(f,{people:[await f.person('Audited Recipient')]});
 assert.equal((await f.execute(campaign)).status,200);
 const rows=f.db.prepare("SELECT details FROM audit WHERE action LIKE '%messaging%'").all();
 assert.ok(rows.length>=4);
 const serialized=JSON.stringify(rows);
 assert.doesNotMatch(serialized,new RegExp(recipients[0].email));
 assert.doesNotMatch(serialized,/Hello Audited Recipient|password|cookie|csrf/);
 assert.match(serialized,/providerTransmitted/);
 assert.throws(()=>f.db.prepare('DELETE FROM messaging_campaigns').run(),/retained/i);
 assert.throws(()=>f.db.prepare("UPDATE messaging_campaigns SET name='tamper'").run(),/immutable|cannot resume or change/i);
 assert.throws(()=>f.db.prepare("UPDATE messaging_recipients SET address='tamper@example.test'").run(),/immutable/i);
 const removal=await f.request('/records/constituents/'+recipients[0].id,{method:'DELETE',session:f.staff,body:{version:recipients[0].version}});
 assert.equal(removal.status,409);assert.match(removal.json.error,/messaging consent|reviewed recipient/i);
 const outcomes=(await f.detail(campaign.id)).json;
 assert.ok(outcomes.outcomes.some(o=>o.status==='Sent'));
 assert.equal(outcomes.deliveries[0].transportMode,'TEST_ONLY');
 assert.match(outcomes.deliveries[0].statement,/No provider transmission/);
});

test('a suspended workspace and a second workspace namespace cannot read or execute retained messaging',async t=>{
 const f=await fixture(t),{campaign}=await reviewedCampaign(f);
 f.suspend();
 assert.equal((await f.request('/messaging/campaigns',{session:f.staff})).status,403);
 assert.equal((await f.execute(campaign)).status,403);
 f.resume();
 await f.switchTenant();
 assert.deepEqual((await f.request('/messaging/campaigns',{session:f.staff})).json.campaigns,[]);
 assert.equal((await f.request('/messaging/campaigns/'+campaign.id,{session:f.staff})).status,404);
 assert.equal((await f.execute(campaign)).status,404);
 assert.equal((await f.request('/messaging/report',{session:f.admin})).json.campaigns.length,0);
 assert.equal(f.transport.sent.length,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_campaigns').get().n,1,'the other workspace rows are retained, not deleted');
});

test('optional SMS is a separately consented channel that only an explicitly configured workspace may use',async t=>{
 const f=await fixture(t),tpl=await f.messagingTemplate({body:'Short reviewed update for {{recipientName}}.'});
 const mobile=await f.person('Mobile Recipient'),landline=await f.person('No Number',{phone:'not a number'});
 assert.equal((await f.consent(mobile,{channel:'Email'})).status,201);
 assert.equal((await f.consent(landline,{channel:'SMS'})).status,400,'a constituent without a valid E.164 number has no SMS address');
 const created=await f.campaign(tpl,{channel:'SMS',name:'Reviewed SMS notice'});
 assert.equal(created.status,201,JSON.stringify(created.json));
 assert.match((await f.review(created.json.campaign,[mobile.id])).json.error,/not eligible/,'Email consent is not SMS consent');
 assert.equal((await f.consent(mobile,{channel:'SMS'})).status,201);
 const reviewed=await f.review(created.json.campaign,[mobile.id]);
 assert.equal(reviewed.status,200,JSON.stringify(reviewed.json));
 const done=await f.execute(reviewed.json.campaign);
 assert.equal(done.status,200,JSON.stringify(done.json));
 assert.equal(f.transport.sent.length,1);
 assert.equal(f.transport.sent[0].channel,'SMS');
 assert.equal(f.transport.sent[0].from,'+15125550100');
 assert.match(f.transport.sent[0].to,/^\+1512555\d{4}$/);
 assert.ok(f.outbound.every(url=>url.startsWith('http://127.0.0.1:')));
 const emailOnly=await fixture(t,{channels:['Email']});
 const refused=await emailOnly.campaign(await emailOnly.messagingTemplate(),{channel:'SMS'});
 assert.equal(refused.status,409);assert.match(refused.json.error,/not configured/);
 assert.equal(emailOnly.transport.sent.length,0);
});

test('no configured transport permits review but refuses every send',async t=>{
 const f=await fixture(t,{enabled:false});
 const status=(await f.request('/messaging/status',{session:f.staff})).json;
 assert.equal(status.enabled,false);assert.equal(status.mode,'Disabled');assert.equal(status.productionReady,false);
 const {campaign}=await reviewedCampaign(f);
 const refused=await f.execute(campaign);assert.equal(refused.status,503);assert.match(refused.json.error,/No messaging transport is configured/);
 assert.equal((await f.request('/messaging/events/intake',{method:'POST',session:f.admin,body:{signature:'t=1,v1='+'a'.repeat(64),payload:'{}'}})).status,503);
 assert.equal(f.transport.sent.length,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messaging_deliveries').get().n,0);
});
