import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';

const START=Date.parse('2026-09-13T12:00:00.000Z');

async function fixture(t,{outbox=true,requestLedgerLimit}={}){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-volunteer-portal-'));
 let app,server,base,tenantActive=true,time=START;
 const sent=[];let response={accepted:true,reference:'fake-outbox'},faulty=false;
 const portal={worker:false,clock:()=>time,rateLimits:{ip:5000,link:5000},...(requestLedgerLimit?{requestLedgerLimit}:{}),...(outbox?{sendReminder:envelope=>{sent.push(envelope);if(faulty)throw new Error('Synthetic outbox fault');return response;}}:{})};
 async function open(){
  app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true,mfaKey:'',isTenantActive:()=>tenantActive,extensions:{volunteerPortal:portal,eventPlanning:{worker:false,clock:()=>time}}});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
 }
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){
  const r=await fetch(base+'/api'+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie}:{}),...(session&&csrf?{'X-CSRF-Token':session.csrfToken}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return {status:r.status,json:await r.json().catch(()=>({}))};
 }
 async function pub(path,{method='GET',body,token,headers={}}={}){
  const r=await fetch(base+'/api/public/volunteer'+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(token?{'X-Volunteer-Token':token}:{}),...headers},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  return {status:r.status,json:await r.json().catch(()=>({}))};
 }
 async function login(email='alex@foundation.example',password='FoundationDemo!2026'){
  const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
  assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.get('set-cookie').split(';')[0]};
 }
 const admin=await login(),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 async function record(collection,body,session=staff){const r=await request('/records/'+collection,{method:'POST',session,body});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.record;}
 const volunteer=(name,changes={})=>record('constituents',{name,email:'',phone:'',type:'Individual',household:'',segments:'',notes:'',...changes});
 const shift=(changes={})=>record('volunteerShifts',{name:'Pantry sorting',date:'2026-09-20',startTime:'09:00',endTime:'12:00',location:'Synthetic pantry',capacity:1,eventId:null,status:'Open',notes:'',...changes});
 async function issue(constituentId,changes={}){
  const r=await request('/volunteer-portal/access',{method:'POST',session:staff,body:{constituentId,days:30,reason:'Synthetic volunteer self-service test',...changes}});
  assert.equal(r.status,201,JSON.stringify(r.json));return r.json;
 }
 const service=()=>app.locals.extensions.services.volunteerPortal;
 return {request,pub,login,admin,staff,viewer,record,volunteer,shift,issue,sent,
  set outbox(value){response=value;},set fault(value){faulty=value;},
  advance:ms=>{time+=ms;},at:()=>time,
  run:()=>service().runVolunteerReminders(time),
  suspend:()=>{tenantActive=false;},resume:()=>{tenantActive=true;},
  restart:async()=>{await close();await open();},
  get db(){return app.locals.db;},get base(){return base;}};
}
const uuid=()=>crypto.randomUUID();
const reservations=f=>f.db.prepare("SELECT json_extract(data,'$.status') status,json_extract(data,'$.constituentId') person FROM records WHERE collection='shiftReservations'").all();

test('link administration needs active staff access, CSRF and a person constituent',async t=>{
 const f=await fixture(t),person=await f.volunteer('Riley Volunteer');
 assert.equal((await f.request('/volunteer-portal')).status,401);
 assert.equal((await f.request('/volunteer-portal',{session:f.viewer})).status,403);
 assert.equal((await f.request('/volunteer-portal',{session:f.staff})).status,200);
 assert.equal((await f.request('/volunteer-portal',{session:f.admin})).status,200);
 assert.equal((await f.request('/volunteer-portal/access',{method:'POST',session:f.staff,csrf:false,body:{constituentId:person.id,days:30,reason:'No CSRF token'}})).status,403);
 assert.equal((await f.request('/volunteer-portal/access',{method:'POST',session:f.viewer,body:{constituentId:person.id,days:30,reason:'Denied role'}})).status,403);
 const organization=await f.record('constituents',{name:'Aspen Partners Two',email:'',phone:'',type:'Business',household:'',segments:'',notes:''});
 assert.equal((await f.request('/volunteer-portal/access',{method:'POST',session:f.staff,body:{constituentId:organization.id,days:30,reason:'Organizations are not volunteers'}})).status,400);
 for(const body of [{constituentId:person.id,days:0,reason:'Too short'},{constituentId:person.id,days:400,reason:'Too long'},{constituentId:person.id,days:30,reason:' '},{constituentId:person.id,days:30,reason:'Extra field',extra:true}])
  assert.equal((await f.request('/volunteer-portal/access',{method:'POST',session:f.staff,body})).status,400,JSON.stringify(body));
 const issued=await f.issue(person.id);
 assert.match(issued.token,/^wv1\.[0-9a-f-]{36}\.[0-9a-f]{64}\.[0-9a-f]{64}$/);
 assert.equal(issued.linkPath,'/volunteer?t='+encodeURIComponent(issued.token));
 assert.equal((await f.request('/volunteer-portal/access',{method:'POST',session:f.staff,body:{constituentId:person.id,days:30,reason:'Second active link'}})).status,409);
 const overview=(await f.request('/volunteer-portal',{session:f.staff})).json;
 assert.equal(overview.access.length,1);
 assert.ok(!JSON.stringify(overview).includes(issued.token),'the issued secret is never returned again');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM volunteer_portal_access').get().n,1);
});

test('a signed link proves itself, expires, revokes and never crosses workspaces',async t=>{
 const f=await fixture(t),person=await f.volunteer('Quinn Volunteer'),{token,access}=await f.issue(person.id);
 assert.equal((await f.pub('')).status,401);
 assert.equal((await f.pub('',{token:'not-a-token'})).status,401);
 assert.equal((await f.pub('',{token:token.slice(0,-1)+(token.at(-1)==='a'?'b':'a')})).status,401);
 assert.equal((await f.pub('',{token:'wv1.'+uuid()+'.'+'a'.repeat(64)+'.'+'b'.repeat(64)})).status,401);
 const ok=await f.pub('',{token});
 assert.equal(ok.status,200);assert.equal(ok.json.volunteer.name,'Quinn Volunteer');
 const other=await fixture(t),otherPerson=await other.volunteer('Quinn Volunteer'),otherIssued=await other.issue(otherPerson.id);
 assert.equal((await other.pub('',{token})).status,401,'a token signed by another workspace is refused');
 assert.equal((await f.pub('',{token:otherIssued.token})).status,401);
 f.advance(31*86400000);
 assert.equal((await f.pub('',{token})).status,403);
 assert.match((await f.pub('',{token})).json.error,/expired/);
 f.advance(-31*86400000);
 assert.equal((await f.request('/volunteer-portal/access/'+access.id+'/revoke',{method:'POST',session:f.staff,body:{version:2,reason:'Stale version'}})).status,409);
 assert.equal((await f.request('/volunteer-portal/access/'+access.id+'/revoke',{method:'POST',session:f.viewer,body:{version:1,reason:'Denied role'}})).status,403);
 const revoked=await f.request('/volunteer-portal/access/'+access.id+'/revoke',{method:'POST',session:f.staff,body:{version:1,reason:'Volunteer left the program'}});
 assert.equal(revoked.status,200);assert.equal(revoked.json.access.status,'Revoked');
 assert.match((await f.pub('',{token})).json.error,/revoked/);
 assert.equal((await f.pub('',{token})).status,403);
 assert.equal((await f.request('/volunteer-portal/access/'+access.id+'/revoke',{method:'POST',session:f.staff,body:{version:2,reason:'Already revoked'}})).status,409);
 assert.throws(()=>f.db.prepare('DELETE FROM volunteer_portal_access').run());
});

test('a link shows only its own volunteer and never constituent, financial or other-volunteer data',async t=>{
 const f=await fixture(t),mine=await f.volunteer('Own Volunteer'),theirs=await f.volunteer('PRIVATE_OTHER_VOLUNTEER');
 const open=await f.shift({capacity:4});
 const myToken=(await f.issue(mine.id)).token,theirToken=(await f.issue(theirs.id)).token;
 await f.pub('/reservations',{method:'POST',token:theirToken,body:{requestId:uuid(),shiftId:open.id,join:'Reserved'}});
 const view=await f.pub('',{token:myToken});
 assert.equal(view.status,200);
 const body=JSON.stringify(view.json);
 assert.ok(!body.includes('PRIVATE_OTHER_VOLUNTEER'),'another volunteer is never named');
 assert.ok(!body.includes('taylor@example.test')&&!body.includes('Taylor Bennett'),'constituent records are never browsable');
 assert.ok(!/"gifts"|"amount"|"campaigns"|"designations"/.test(body),'no financial data reaches the public link');
 assert.deepEqual(view.json.reservations,[]);
 assert.equal(view.json.shifts.length,1);
 assert.deepEqual(Object.keys(view.json.shifts[0]).sort(),['capacity','date','endTime','eventId','id','location','name','past','placesLeft','reservedCount','startTime','startsAt','status','version','waitlistCount']);
 assert.equal(view.json.shifts[0].reservedCount,1);
 assert.match(view.json.scope,/only your own volunteer shifts/);
 for(const path of ['/../../workspace','/reservations/'+uuid()])assert.ok([401,404,405].includes((await f.pub(path,{token:myToken})).status));
 assert.equal((await f.request('/workspace',{session:{cookie:'x=y',csrfToken:'z'}})).status,401);
});

test('two simultaneous sign-ups can never exceed capacity and the loser is offered the waitlist',async t=>{
 const f=await fixture(t),single=await f.shift({capacity:1});
 const first=await f.volunteer('First Racer'),second=await f.volunteer('Second Racer');
 const a=(await f.issue(first.id)).token,b=(await f.issue(second.id)).token;
 const results=await Promise.all([
  f.pub('/reservations',{method:'POST',token:a,body:{requestId:uuid(),shiftId:single.id,join:'Reserved'}}),
  f.pub('/reservations',{method:'POST',token:b,body:{requestId:uuid(),shiftId:single.id,join:'Reserved'}})
 ]);
 const created=results.filter(r=>r.status===201),refused=results.filter(r=>r.status===409);
 assert.equal(created.length,1);assert.equal(refused.length,1);
 assert.match(refused[0].json.error,/full/);
 assert.equal(reservations(f).filter(r=>r.status==='Reserved').length,1);
 const waitlisted=await f.pub('/reservations',{method:'POST',token:b,body:{requestId:uuid(),shiftId:single.id,join:'Waitlisted'}});
 assert.equal(waitlisted.status,201,JSON.stringify(waitlisted.json));
 assert.equal(waitlisted.json.status,'Waitlisted');
 assert.equal((await f.pub('/reservations',{method:'POST',token:b,body:{requestId:uuid(),shiftId:single.id,join:'Waitlisted'}})).status,409);
 assert.equal(reservations(f).filter(r=>r.status==='Reserved').length,1);
});

test('a replayed confirmation returns the saved answer and creates nothing new',async t=>{
 const f=await fixture(t),spot=await f.shift({capacity:2}),person=await f.volunteer('Replay Volunteer');
 const token=(await f.issue(person.id)).token,requestId=uuid();
 const first=await f.pub('/reservations',{method:'POST',token,body:{requestId,shiftId:spot.id,join:'Reserved'}});
 assert.equal(first.status,201);assert.notEqual(first.json.replayed,true);
 const replayed=await f.pub('/reservations',{method:'POST',token,body:{requestId,shiftId:spot.id,join:'Reserved'}});
 assert.equal(replayed.status,200);assert.equal(replayed.json.replayed,true);
 assert.equal(replayed.json.reservationId,first.json.reservationId);
 assert.equal(reservations(f).length,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM volunteer_portal_requests').get().n,1);
 assert.throws(()=>f.db.prepare('DELETE FROM volunteer_portal_requests').run());
});

test('self-cancellation retains history and promotes the waitlist without exceeding capacity',async t=>{
 const f=await fixture(t),single=await f.shift({capacity:1});
 const holder=await f.volunteer('Holder Volunteer'),next=await f.volunteer('Next Volunteer'),later=await f.volunteer('Later Volunteer');
 const holderToken=(await f.issue(holder.id)).token,nextToken=(await f.issue(next.id)).token,laterToken=(await f.issue(later.id)).token;
 const held=await f.pub('/reservations',{method:'POST',token:holderToken,body:{requestId:uuid(),shiftId:single.id,join:'Reserved'}});
 assert.equal(held.status,201);
 assert.equal((await f.pub('/reservations',{method:'POST',token:nextToken,body:{requestId:uuid(),shiftId:single.id,join:'Waitlisted'}})).status,201);
 await new Promise(resolve=>setTimeout(resolve,5));
 assert.equal((await f.pub('/reservations',{method:'POST',token:laterToken,body:{requestId:uuid(),shiftId:single.id,join:'Waitlisted'}})).status,201);
 const mine=(await f.pub('',{token:holderToken})).json.reservations[0];
 assert.equal((await f.pub('/reservations/'+mine.id+'/cancel',{method:'POST',token:nextToken,body:{requestId:uuid(),version:mine.version,reason:'Not mine'}})).status,404,'a link never reaches another volunteer’s place');
 assert.equal((await f.pub('/reservations/'+mine.id+'/cancel',{method:'POST',token:holderToken,body:{requestId:uuid(),version:mine.version+5,reason:'Stale'}})).status,409);
 const cancelled=await f.pub('/reservations/'+mine.id+'/cancel',{method:'POST',token:holderToken,body:{requestId:uuid(),version:mine.version,reason:'Family commitment'}});
 assert.equal(cancelled.status,200,JSON.stringify(cancelled.json));
 assert.equal(cancelled.json.status,'Cancelled');assert.equal(cancelled.json.promotedCount,1);
 const rows=reservations(f);
 assert.equal(rows.filter(r=>r.status==='Reserved').length,1);
 assert.equal(rows.filter(r=>r.status==='Reserved')[0].person,next.id);
 assert.equal(rows.filter(r=>r.status==='Waitlisted')[0].person,later.id);
 assert.equal(rows.filter(r=>r.status==='Cancelled').length,1);
 const history=(await f.pub('',{token:holderToken})).json.reservations[0].history;
 assert.deepEqual(history.map(h=>h.action),['Reserved','Self-cancelled']);
 assert.equal(history[1].actorKind,'Volunteer');assert.equal(history[1].reason,'Family commitment');
 const promotedHistory=(await f.pub('',{token:nextToken})).json.reservations[0].history;
 assert.deepEqual(promotedHistory.map(h=>h.action),['Joined waitlist','Promoted from waitlist']);
 assert.throws(()=>f.db.prepare('UPDATE volunteer_reservation_history SET reason=?').run('tamper'));
 assert.throws(()=>f.db.prepare('DELETE FROM volunteer_reservation_history').run());
 assert.equal((await f.request('/records/shiftReservations/'+mine.id,{method:'DELETE',session:f.staff,body:{version:2}})).status,403);
});

test('reminders are configurable, consent-gated, queued once and never claim delivery',async t=>{
 const f=await fixture(t),slot=await f.shift({capacity:3,date:'2026-09-20',startTime:'09:00'});
 const person=await f.volunteer('Reminder Volunteer'),token=(await f.issue(person.id)).token;
 assert.equal((await f.request('/volunteer-portal/shifts/'+slot.id+'/reminder-config',{method:'POST',session:f.viewer,body:{leadMinutes:[60],enabled:true,reason:'Denied role'}})).status,403);
 assert.equal((await f.request('/volunteer-portal/shifts/'+slot.id+'/reminder-config',{method:'POST',session:f.staff,body:{leadMinutes:[60,60],enabled:true,reason:'Duplicate leads'}})).status,400);
 const configured=await f.request('/volunteer-portal/shifts/'+slot.id+'/reminder-config',{method:'POST',session:f.staff,body:{leadMinutes:[1440,120],enabled:true,reason:'Two reminders before the shift'}});
 assert.equal(configured.status,200,JSON.stringify(configured.json));
 assert.deepEqual(configured.json.reminderConfig.leadMinutes,[1440,120]);
 assert.match(configured.json.delivery,/not delivery/i);
 assert.equal((await f.pub('/reservations',{method:'POST',token,body:{requestId:uuid(),shiftId:slot.id,join:'Reserved'}})).status,201);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM volunteer_reminders WHERE status='Pending'").get().n,2);
 f.advance(Date.parse('2026-09-19T09:00:00.000Z')-f.at());
 assert.deepEqual(f.run(),{queued:0,suppressed:1,failed:0,suspended:false},'consent is required before anything is queued');
 assert.equal(f.sent.length,0);
 assert.equal(f.db.prepare("SELECT reason FROM volunteer_reminder_outcomes ORDER BY rowid DESC LIMIT 1").get().reason,'Reminder consent is not granted');
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM volunteer_reminders WHERE status='Pending'").get().n,1,'a reminder that is not yet due is never written off early');
 assert.equal((await f.pub('/consent',{method:'POST',token,body:{requestId:uuid(),granted:true}})).status,200);
 f.advance(Date.parse('2026-09-20T07:00:00.000Z')-f.at());
 assert.deepEqual(f.run(),{queued:1,suppressed:0,failed:0,suspended:false});
 assert.equal(f.sent.length,1);
 assert.deepEqual(Object.keys(f.sent[0]).sort(),['consent','constituentId','delivery','kind','leadMinutes','reminderId','reservationId','sendAt','shiftId','shiftName','startsAt']);
 assert.ok(!('email' in f.sent[0])&&!('address' in f.sent[0])&&!('body' in f.sent[0]));
 assert.match(f.sent[0].delivery,/not performed, confirmed or claimed/);
 assert.deepEqual(f.run(),{queued:0,suppressed:0,failed:0,suspended:false},'a queued reminder is never queued twice');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM volunteer_reminder_notices').get().n,1);
 assert.throws(()=>f.db.prepare('UPDATE volunteer_reminder_notices SET queued_at=?').run('tamper'));
 assert.throws(()=>f.db.prepare('DELETE FROM volunteer_reminder_notices').run());
 const listed=(await f.request('/volunteer-portal',{session:f.staff})).json;
 assert.equal(listed.reminders.filter(r=>r.status==='Queued').length,1);
 assert.match(listed.delivery,/not delivery/i);
 const detail=(await f.request('/volunteer-portal/reminders/'+listed.reminders.find(r=>r.status==='Queued').id,{session:f.staff})).json;
 assert.equal(detail.reminder.queued,true);
 assert.match(detail.outcomes[0].reason,/External delivery is not performed/);
});

test('withdrawn consent and a do-not-contact preference each suppress reminders separately',async t=>{
 const f=await fixture(t),slot=await f.shift({capacity:4});
 const withdrawer=await f.volunteer('Consent Volunteer'),blocked=await f.volunteer('Blocked Volunteer',{preference:'Do not contact'});
 await f.request('/volunteer-portal/shifts/'+slot.id+'/reminder-config',{method:'POST',session:f.staff,body:{leadMinutes:[60],enabled:true,reason:'One reminder'}});
 const withdrawerToken=(await f.issue(withdrawer.id)).token,blockedToken=(await f.issue(blocked.id)).token;
 for(const token of [withdrawerToken,blockedToken]){
  assert.equal((await f.pub('/reservations',{method:'POST',token,body:{requestId:uuid(),shiftId:slot.id,join:'Reserved'}})).status,201);
  assert.equal((await f.pub('/consent',{method:'POST',token,body:{requestId:uuid(),granted:true}})).status,200);
 }
 f.advance(Date.parse('2026-09-20T08:00:00.000Z')-f.at());
 const first=f.run();
 assert.equal(first.queued,1,'consent granted but a do-not-contact preference still blocks one');
 assert.equal(first.suppressed,1);
 assert.ok(f.db.prepare("SELECT 1 FROM volunteer_reminder_outcomes WHERE reason='Contact preference blocks this reminder'").get());
 assert.equal(f.sent.length,1);
 const withdrawn=await f.pub('/consent',{method:'POST',token:withdrawerToken,body:{requestId:uuid(),granted:false}});
 assert.equal(withdrawn.status,200);assert.equal(withdrawn.json.consent.granted,false);
 const staffGrant=await f.request('/volunteer-portal/consent',{method:'POST',session:f.staff,body:{constituentId:withdrawer.id,granted:true,reason:'Staff cannot override a volunteer withdrawal'}});
 assert.equal(staffGrant.status,409);
 assert.match(staffGrant.json.error,/Only the volunteer can grant it again/);
 assert.equal((await f.pub('/consent',{method:'POST',token:withdrawerToken,body:{requestId:uuid(),granted:true}})).status,200);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM volunteer_consent_changes').get().n,4);
 assert.throws(()=>f.db.prepare('UPDATE volunteer_consent_changes SET basis=?').run('tamper'));
});

test('a failing outbox retains no queued evidence, schedules a bounded retry and stops at five attempts',async t=>{
 const f=await fixture(t),slot=await f.shift({capacity:2});
 const person=await f.volunteer('Retry Volunteer'),token=(await f.issue(person.id)).token;
 await f.request('/volunteer-portal/shifts/'+slot.id+'/reminder-config',{method:'POST',session:f.staff,body:{leadMinutes:[60],enabled:true,reason:'One reminder'}});
 await f.pub('/reservations',{method:'POST',token,body:{requestId:uuid(),shiftId:slot.id,join:'Reserved'}});
 await f.pub('/consent',{method:'POST',token,body:{requestId:uuid(),granted:true}});
 const financial=f.db.prepare("SELECT * FROM records WHERE collection='gifts' ORDER BY id").all();
 f.fault=true;f.advance(Date.parse('2026-09-20T08:00:00.000Z')-f.at());
 for(let attempt=1;attempt<=5;attempt++){
  f.advance(60000);
  const run=f.run();
  assert.equal(run.failed,1,'attempt '+attempt);
  assert.equal(run.suppressed,attempt===5?1:0);
  assert.equal(run.queued,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM volunteer_reminder_notices').get().n,0);
 }
 const row=f.db.prepare('SELECT * FROM volunteer_reminders').get();
 assert.equal(row.status,'Suppressed');assert.equal(row.attempt_count,5);
 assert.match(f.db.prepare('SELECT reason FROM volunteer_reminder_outcomes ORDER BY rowid DESC LIMIT 1').get().reason,/Retry limit/);
 assert.deepEqual(f.db.prepare("SELECT * FROM records WHERE collection='gifts' ORDER BY id").all(),financial,'no revenue effect');
 assert.equal(reservations(f).filter(r=>r.status==='Reserved').length,1,'the volunteer keeps their place');
});

test('reservations, links, history and reminders survive a restart with the same signing key',async t=>{
 const f=await fixture(t),slot=await f.shift({capacity:2});
 const person=await f.volunteer('Durable Volunteer'),token=(await f.issue(person.id)).token;
 await f.request('/volunteer-portal/shifts/'+slot.id+'/reminder-config',{method:'POST',session:f.staff,body:{leadMinutes:[60],enabled:true,reason:'One reminder'}});
 await f.pub('/reservations',{method:'POST',token,body:{requestId:uuid(),shiftId:slot.id,join:'Reserved'}});
 await f.pub('/consent',{method:'POST',token,body:{requestId:uuid(),granted:true}});
 await f.restart();
 const view=await f.pub('',{token});
 assert.equal(view.status,200,'the signing key is persisted, not regenerated');
 assert.equal(view.json.reservations.length,1);
 assert.equal(view.json.reservations[0].status,'Reserved');
 assert.equal(view.json.consent.granted,true);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM volunteer_reminders WHERE status='Pending'").get().n,1);
 f.advance(Date.parse('2026-09-20T08:00:00.000Z')-f.at());
 assert.equal(f.run().queued,1);
 await f.restart();
 assert.equal(f.run().queued,0);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM volunteer_reminder_notices').get().n,1);
});

test('suspension closes the link, the staff screen and every pending reminder',async t=>{
 const f=await fixture(t),slot=await f.shift({capacity:2});
 const person=await f.volunteer('Suspended Volunteer'),token=(await f.issue(person.id)).token;
 await f.request('/volunteer-portal/shifts/'+slot.id+'/reminder-config',{method:'POST',session:f.staff,body:{leadMinutes:[60],enabled:true,reason:'One reminder'}});
 await f.pub('/reservations',{method:'POST',token,body:{requestId:uuid(),shiftId:slot.id,join:'Reserved'}});
 await f.pub('/consent',{method:'POST',token,body:{requestId:uuid(),granted:true}});
 f.suspend();
 assert.equal((await f.pub('',{token})).status,403);
 assert.equal((await f.request('/volunteer-portal',{session:f.staff})).status,403);
 assert.deepEqual(f.run(),{queued:0,suppressed:1,failed:0,suspended:true});
 assert.equal(f.sent.length,0);
 f.resume();f.advance(Date.parse('2026-09-20T08:00:00.000Z')-f.at());
 assert.equal(f.run().queued,0,'reinstatement never resumes a suppressed reminder');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM volunteer_reminder_notices').get().n,0);
 assert.equal((await f.pub('',{token})).status,200);
});

test('the public surface refuses cross-site requests, other methods and oversized bodies',async t=>{
 const f=await fixture(t),person=await f.volunteer('Guarded Volunteer'),token=(await f.issue(person.id)).token;
 assert.equal((await f.pub('',{token,headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 assert.equal((await f.pub('',{token,headers:{Origin:'https://attacker.example'}})).status,403);
 assert.equal((await f.pub('',{token,headers:{'Sec-Fetch-Site':'same-origin'}})).status,200);
 assert.equal((await f.pub('',{method:'DELETE',token})).status,405);
 assert.equal((await f.pub('',{method:'PUT',token})).status,405);
 const slot=await f.shift({capacity:2});
 assert.equal((await f.pub('/reservations',{method:'POST',token,body:{requestId:uuid(),shiftId:slot.id,join:'Reserved',notes:'x'.repeat(6000)}})).status,413);
 assert.equal((await f.pub('/reservations',{method:'POST',token,body:{requestId:uuid(),shiftId:slot.id,join:'Attending'}})).status,400);
 assert.equal((await f.pub('/reservations',{method:'POST',token,body:{requestId:'not-a-uuid',shiftId:slot.id,join:'Reserved'}})).status,400);
 assert.equal((await f.pub('/reservations',{method:'POST',token,body:{requestId:uuid(),shiftId:slot.id,join:'Reserved',extra:true}})).status,400);
 assert.equal(reservations(f).length,0);
});

test('with no injected outbox the engine stays internal only and contacts nothing',async t=>{
 const f=await fixture(t,{outbox:false}),slot=await f.shift({capacity:2});
 const person=await f.volunteer('Internal Volunteer'),token=(await f.issue(person.id)).token;
 const original=globalThis.fetch;let external=0;
 globalThis.fetch=(...args)=>{if(!String(args[0]).startsWith(f.base))external++;return original(...args);};
 t.after(()=>{globalThis.fetch=original;});
 await f.request('/volunteer-portal/shifts/'+slot.id+'/reminder-config',{method:'POST',session:f.staff,body:{leadMinutes:[60],enabled:true,reason:'One reminder'}});
 await f.pub('/reservations',{method:'POST',token,body:{requestId:uuid(),shiftId:slot.id,join:'Reserved'}});
 await f.pub('/consent',{method:'POST',token,body:{requestId:uuid(),granted:true}});
 const overview=(await f.request('/volunteer-portal',{session:f.staff})).json;
 assert.deepEqual(overview.outbox,{configured:false,mode:'Internal only'});
 f.advance(Date.parse('2026-09-20T08:00:00.000Z')-f.at());
 assert.equal(f.run().queued,1);
 assert.equal(f.db.prepare('SELECT outbox_reference FROM volunteer_reminder_notices').get().outbox_reference,'internal-only');
 assert.equal(external,0,'no external request is made');
});

test('closed shifts, started shifts and retained history are protected from staff shortcuts',async t=>{
 const f=await fixture(t),slot=await f.shift({capacity:2});
 const person=await f.volunteer('Protected Volunteer'),token=(await f.issue(person.id)).token;
 const created=await f.pub('/reservations',{method:'POST',token,body:{requestId:uuid(),shiftId:slot.id,join:'Reserved'}});
 assert.equal(created.status,201);
 assert.equal((await f.request('/records/volunteerShifts/'+slot.id,{method:'DELETE',session:f.staff,body:{version:1}})).status,409);
 assert.equal((await f.request('/records/constituents/'+person.id,{method:'DELETE',session:f.staff,body:{version:1}})).status,409);
 const mine=(await f.pub('',{token})).json.reservations[0];
 f.advance(Date.parse('2026-09-20T10:00:00.000Z')-f.at());
 assert.equal((await f.pub('/reservations/'+mine.id+'/cancel',{method:'POST',token,body:{requestId:uuid(),version:mine.version,reason:'Too late'}})).status,409);
 assert.equal((await f.request('/volunteer-portal/reservations/'+mine.id+'/cancel',{method:'POST',session:f.staff,body:{version:mine.version,reason:'Too late for staff too'}})).status,409);
 f.advance(Date.parse('2026-09-19T10:00:00.000Z')-f.at());
 const staffCancel=await f.request('/volunteer-portal/reservations/'+mine.id+'/cancel',{method:'POST',session:f.staff,body:{version:mine.version,reason:'Volunteer called the office'}});
 assert.equal(staffCancel.status,200,JSON.stringify(staffCancel.json));
 assert.equal(staffCancel.json.reservation.status,'Cancelled');
 const history=(await f.pub('',{token})).json.reservations[0].history;
 assert.equal(history.at(-1).action,'Cancelled');assert.equal(history.at(-1).actorKind,'Staff');
 assert.equal((await f.pub('/reservations',{method:'POST',token,body:{requestId:uuid(),shiftId:slot.id,join:'Reserved'}})).status,201,'a cancelled place never blocks a new sign-up');
});

// --- Self-reported arrival and departure ------------------------------------
// A claim is a claim. These tests exist to prove the hours ledger stays the sole
// property of the existing volunteer clock endpoint in server/app.js.
const ledgerRows=f=>f.db.prepare("SELECT collection,id,data FROM records WHERE collection IN ('volunteerTime','volunteers') ORDER BY collection,id").all();
async function claimable(f,{capacity=2}={}){
 const slot=await f.shift({capacity,date:'2026-09-20',startTime:'09:00',endTime:'12:00'});
 const person=await f.volunteer('Arriving Volunteer'),issued=await f.issue(person.id);
 const created=await f.pub('/reservations',{method:'POST',token:issued.token,body:{requestId:uuid(),shiftId:slot.id,join:'Reserved'}});
 assert.equal(created.status,201,JSON.stringify(created.json));
 f.advance(Date.parse('2026-09-20T12:30:00.000Z')-f.at());
 const mine=(await f.pub('',{token:issued.token})).json.reservations[0];
 return {slot,person,token:issued.token,access:issued.access,reservation:mine};
}
const claimBody=(reservation,changes={})=>({requestId:uuid(),version:reservation.version,arrivedAt:'2026-09-20T09:05:00.000Z',departedAt:'2026-09-20T12:00:00.000Z',...changes});

test('a volunteer records arrival and departure as a claim that writes no hours at all',async t=>{
 const f=await fixture(t),{token,reservation,person}=await claimable(f);
 const before=ledgerRows(f);
 for(const changes of [{arrivedAt:'2026-09-20T12:00:00.000Z',departedAt:'2026-09-20T09:00:00.000Z'},{departedAt:'2026-09-21T23:00:00.000Z'},{arrivedAt:'2026-09-19T00:00:00.000Z'},{arrivedAt:'2026-09-20T09:05:00'},{departedAt:'2026-09-20T23:00:00.000Z'}])
  assert.equal((await f.pub('/reservations/'+reservation.id+'/attendance',{method:'POST',token,body:claimBody(reservation,changes)})).status,400,JSON.stringify(changes));
 assert.equal((await f.pub('/reservations/'+reservation.id+'/attendance',{method:'POST',token,body:claimBody(reservation,{version:reservation.version+4})})).status,409);
 const claimed=await f.pub('/reservations/'+reservation.id+'/attendance',{method:'POST',token,body:claimBody(reservation)});
 assert.equal(claimed.status,201,JSON.stringify(claimed.json));
 assert.equal(claimed.json.status,'Claimed');
 assert.match(claimed.json.attendance,/not confirmed hours/);
 assert.match(claimed.json.ledger,/No hours were written/);
 assert.equal((await f.pub('/reservations/'+reservation.id+'/attendance',{method:'POST',token,body:claimBody(reservation)})).status,409,'one standing claim per place');
 assert.deepEqual(ledgerRows(f),before,'volunteerTime and volunteers rows are byte-unchanged');
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM records WHERE collection='volunteerTime'").get().n,before.filter(r=>r.collection==='volunteerTime').length);
 const own=(await f.pub('',{token})).json.reservations[0];
 assert.equal(own.claim.status,'Claimed');
 assert.equal(own.claim.claimedMinutes,175);
 assert.match(own.claim.meaning,/never counted in the volunteer time ledger/);
 const staffView=(await f.request('/volunteer-portal',{session:f.staff})).json;
 assert.equal(staffView.pendingClaimCount,1);
 assert.equal(staffView.claims[0].constituentId,person.id);
 assert.equal(staffView.claims[0].arrivedAt,'2026-09-20T09:05:00.000Z');
 assert.match(staffView.attendance,/not confirmed hours/);
 const readiness=(await f.request('/readiness',{session:f.admin})).json;
 assert.equal(readiness.checks.find(c=>c.key==='time-ledger').status,'Passed','claims never break hour reconciliation');
});

test('staff confirm and reject claims with retained reasons and still write no hours',async t=>{
 const f=await fixture(t),{token,reservation,slot}=await claimable(f,{capacity:3});
 const other=await f.volunteer('Second Arriving Volunteer'),otherToken=(await f.issue(other.id)).token;
 f.advance(Date.parse('2026-09-19T08:00:00.000Z')-f.at());
 assert.equal((await f.pub('/reservations',{method:'POST',token:otherToken,body:{requestId:uuid(),shiftId:slot.id,join:'Reserved'}})).status,201);
 f.advance(Date.parse('2026-09-20T12:30:00.000Z')-f.at());
 const theirs=(await f.pub('',{token:otherToken})).json.reservations[0];
 assert.equal((await f.pub('/reservations/'+reservation.id+'/attendance',{method:'POST',token,body:claimBody(reservation)})).status,201);
 assert.equal((await f.pub('/reservations/'+theirs.id+'/attendance',{method:'POST',token:otherToken,body:claimBody(theirs)})).status,201);
 const mineOnly=(await f.pub('',{token})).json;
 assert.equal(mineOnly.reservations.length,1);
 assert.ok(!JSON.stringify(mineOnly).includes('Second Arriving Volunteer'),'another volunteer’s claim is never visible');
 const before=ledgerRows(f);
 const claims=(await f.request('/volunteer-portal',{session:f.staff})).json.claims;
 const mineClaim=claims.find(c=>c.reservationId===reservation.id),theirClaim=claims.find(c=>c.reservationId===theirs.id);
 assert.equal((await f.request('/volunteer-portal/claims/'+mineClaim.id+'/confirm',{method:'POST',session:f.viewer,body:{version:1,reason:'Denied role'}})).status,403);
 assert.equal((await f.request('/volunteer-portal/claims/'+mineClaim.id+'/confirm',{method:'POST',session:f.staff,csrf:false,body:{version:1,reason:'No CSRF'}})).status,403);
 assert.equal((await f.request('/volunteer-portal/claims/'+mineClaim.id+'/confirm',{method:'POST',session:f.staff,body:{version:9,reason:'Stale'}})).status,409);
 assert.equal((await f.request('/volunteer-portal/claims/'+mineClaim.id+'/confirm',{method:'POST',session:f.staff,body:{version:1,reason:' '}})).status,400);
 const confirmed=await f.request('/volunteer-portal/claims/'+mineClaim.id+'/confirm',{method:'POST',session:f.staff,body:{version:1,reason:'Supervisor saw them on site'}});
 assert.equal(confirmed.status,200,JSON.stringify(confirmed.json));
 assert.equal(confirmed.json.claim.status,'Confirmed');
 assert.equal(confirmed.json.ledger.written,false);
 assert.match(confirmed.json.ledger.note,/volunteer clock/);
 assert.equal((await f.request('/volunteer-portal/claims/'+mineClaim.id+'/reject',{method:'POST',session:f.staff,body:{version:2,reason:'Second decision'}})).status,409);
 const rejected=await f.request('/volunteer-portal/claims/'+theirClaim.id+'/reject',{method:'POST',session:f.staff,body:{version:1,reason:'No record of this volunteer attending'}});
 assert.equal(rejected.status,200);
 assert.equal(rejected.json.claim.status,'Rejected');
 assert.equal(rejected.json.claim.decisionReason,'No record of this volunteer attending');
 assert.deepEqual(rejected.json.claim.decisions.map(d=>d.status),['Claimed','Rejected']);
 assert.deepEqual(ledgerRows(f),before,'confirming or rejecting a claim writes no hours');
 assert.throws(()=>f.db.prepare('UPDATE volunteer_attendance_decisions SET reason=?').run('tamper'));
 assert.throws(()=>f.db.prepare('DELETE FROM volunteer_attendance_claims').run());
 assert.equal((await f.request('/readiness',{session:f.admin})).json.checks.find(c=>c.key==='time-ledger').status,'Passed');
 assert.equal((await f.pub('/reservations/'+theirs.id+'/attendance',{method:'POST',token:otherToken,body:claimBody(theirs)})).status,201,'a rejected claim may be replaced, and the rejection is retained');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM volunteer_attendance_claims').get().n,3);
});

test('a claim is refused or suppressed when its place, link or shift is no longer current',async t=>{
 const f=await fixture(t),{token,reservation,access,slot}=await claimable(f);
 const waitlisted=await f.volunteer('Waiting Volunteer'),waitingToken=(await f.issue(waitlisted.id)).token;
 f.advance(Date.parse('2026-09-19T08:00:00.000Z')-f.at());
 assert.equal((await f.pub('/reservations',{method:'POST',token:waitingToken,body:{requestId:uuid(),shiftId:slot.id,join:'Waitlisted'}})).status,201);
 f.advance(Date.parse('2026-09-20T12:30:00.000Z')-f.at());
 const waitingPlace=(await f.pub('',{token:waitingToken})).json.reservations[0];
 assert.equal((await f.pub('/reservations/'+waitingPlace.id+'/attendance',{method:'POST',token:waitingToken,body:claimBody(waitingPlace)})).status,409,'a waitlist place cannot claim attendance');
 assert.equal((await f.pub('/reservations/'+reservation.id+'/attendance',{method:'POST',token:waitingToken,body:claimBody(reservation)})).status,404,'a link never reaches another volunteer’s place');
 assert.equal((await f.pub('/reservations/'+reservation.id+'/attendance',{method:'POST',token,body:claimBody(reservation)})).status,201);
 const claim=(await f.request('/volunteer-portal',{session:f.staff})).json.claims.find(c=>c.reservationId===reservation.id);
 const before=ledgerRows(f);
 const cancelled=await f.request('/volunteer-portal/reservations/'+reservation.id+'/cancel',{method:'POST',session:f.staff,body:{version:reservation.version,reason:'Recorded in error'}});
 assert.equal(cancelled.status,409,'a started shift cannot be cancelled');
 f.advance(Date.parse('2026-09-19T08:00:00.000Z')-f.at());
 const reversed=await f.request('/volunteer-portal/reservations/'+reservation.id+'/cancel',{method:'POST',session:f.staff,body:{version:reservation.version,reason:'Place recorded in error'}});
 assert.equal(reversed.status,200,JSON.stringify(reversed.json));
 assert.equal(reversed.json.claimsSuppressed,1);
 const suppressed=(await f.request('/volunteer-portal/claims/'+claim.id,{session:f.staff})).json.claim;
 assert.equal(suppressed.status,'Suppressed');
 assert.match(suppressed.decisionReason,/cancelled/);
 assert.deepEqual(suppressed.decisions.map(d=>d.status),['Claimed','Suppressed']);
 assert.equal((await f.request('/volunteer-portal/claims/'+claim.id+'/confirm',{method:'POST',session:f.staff,body:{version:suppressed.version,reason:'Too late'}})).status,409);
 assert.deepEqual(ledgerRows(f),before);
 const revoked=await f.request('/volunteer-portal/access/'+access.id+'/revoke',{method:'POST',session:f.staff,body:{version:1,reason:'Link revoked'}});
 assert.equal(revoked.status,200);
 f.advance(Date.parse('2026-09-20T12:30:00.000Z')-f.at());
 assert.equal((await f.pub('/reservations/'+reservation.id+'/attendance',{method:'POST',token,body:claimBody(reservation)})).status,403,'a revoked link records nothing');
});

test('an expired link records no claim, and a shift time change suppresses a standing one',async t=>{
 const f=await fixture(t),{token,reservation,slot}=await claimable(f);
 assert.equal((await f.pub('/reservations/'+reservation.id+'/attendance',{method:'POST',token,body:claimBody(reservation)})).status,201);
 const claim=(await f.request('/volunteer-portal',{session:f.staff})).json.claims[0];
 assert.equal(claim.sourceCurrent,true);
 const shift=(await f.request('/workspace',{session:f.staff})).json.data.volunteerShifts.find(s=>s.id===slot.id);
 // The existing record rules already refuse a shift time change once places exist.
 // The stored signature is defence in depth for any path that does not go through
 // them, so the drift is produced directly rather than through the API.
 assert.equal((await f.request('/records/volunteerShifts/'+slot.id,{method:'PATCH',session:f.staff,body:{version:shift.version,name:shift.name,date:shift.date,startTime:shift.startTime,endTime:'13:00',location:shift.location,capacity:shift.capacity,eventId:null,status:'Open',notes:''}})).status,409);
 f.db.prepare("UPDATE records SET data=? WHERE collection='volunteerShifts' AND id=?").run(JSON.stringify({...shift,endTime:'13:00',version:shift.version+1}),slot.id);
 const stale=(await f.request('/volunteer-portal/claims/'+claim.id,{session:f.staff})).json.claim;
 assert.equal(stale.sourceCurrent,false);
 assert.match(stale.sourceProblem,/times changed/);
 const before=ledgerRows(f);
 const decision=await f.request('/volunteer-portal/claims/'+claim.id+'/confirm',{method:'POST',session:f.staff,body:{version:claim.version,reason:'Attempted confirmation after the shift moved'}});
 assert.equal(decision.status,200);
 assert.equal(decision.json.outcome,'Suppressed');
 assert.equal(decision.json.claim.status,'Suppressed');
 assert.deepEqual(ledgerRows(f),before,'a suppressed claim never reaches the hours ledger');
 f.advance(31*86400000);
 assert.equal((await f.pub('/reservations/'+reservation.id+'/attendance',{method:'POST',token,body:claimBody(reservation)})).status,403,'an expired link records nothing');
});

test('claims, decisions and their suppression survive a restart',async t=>{
 const f=await fixture(t),{token,reservation}=await claimable(f);
 assert.equal((await f.pub('/reservations/'+reservation.id+'/attendance',{method:'POST',token,body:claimBody(reservation)})).status,201);
 const claim=(await f.request('/volunteer-portal',{session:f.staff})).json.claims[0];
 assert.equal((await f.request('/volunteer-portal/claims/'+claim.id+'/confirm',{method:'POST',session:f.staff,body:{version:1,reason:'Site supervisor confirmed attendance'}})).status,200);
 const before=ledgerRows(f);
 await f.restart();
 const fresh=await f.login('staff@foundation.example');
 const after=(await f.request('/volunteer-portal',{session:fresh})).json;
 assert.equal(after.claims.length,1);
 assert.equal(after.claims[0].status,'Confirmed');
 assert.equal(after.claims[0].decisionReason,'Site supervisor confirmed attendance');
 assert.deepEqual(after.claims[0].decisions.map(d=>d.status),['Claimed','Confirmed']);
 assert.equal(after.pendingClaimCount,0);
 assert.deepEqual(ledgerRows(f),before,'a restart never materialises hours from a confirmed claim');
 assert.equal((await f.pub('',{token})).json.reservations[0].claim.status,'Confirmed');
 assert.equal((await f.request('/readiness',{session:f.admin})).json.checks.find(c=>c.key==='time-ledger').status,'Passed');
});

// --- Bounded replay evidence -------------------------------------------------
// The replay ledger is retained and cannot be deleted, so it must refuse rather
// than grow. The ceiling is per sign-up link: one volunteer's link can never
// consume the workspace row budget that the backup archive depends on.
test('retained replay evidence is bounded per link and refuses instead of growing',async t=>{
 const f=await fixture(t,{requestLedgerLimit:3}),person=await f.volunteer('Bounded Volunteer');
 const {token,access}=await f.issue(person.id);
 const ledger=()=>f.db.prepare('SELECT COUNT(*) n FROM volunteer_portal_requests WHERE access_id=?').get(access.id).n;
 const used=[];
 for(const granted of [true,false,true]){
  const requestId=uuid();used.push({requestId,granted});
  const result=await f.pub('/consent',{method:'POST',token,body:{requestId,granted}});
  assert.equal(result.status,200,JSON.stringify(result.json));
 }
 assert.equal(ledger(),3);
 assert.equal((await f.pub('',{token})).json.link.confirmationsRecorded,3);
 const refused=await f.pub('/consent',{method:'POST',token,body:{requestId:uuid(),granted:false}});
 assert.equal(refused.status,409);
 assert.match(refused.json.error,/recorded its limit of 3 confirmations/);
 assert.match(refused.json.error,/Ask staff for a new link/);
 assert.equal(ledger(),3,'a refusal writes no further retained evidence');
 const slot=await f.shift({capacity:2});
 const signup=await f.pub('/reservations',{method:'POST',token,body:{requestId:uuid(),shiftId:slot.id,join:'Reserved'}});
 assert.equal(signup.status,409,'every confirming action shares one bounded ledger');
 assert.equal(ledger(),3);
 assert.equal(reservations(f).length,0,'a refused confirmation performs no work at all');
 assert.equal((await f.pub('',{token})).status,200,'reading your own shifts is never refused by the ceiling');
});

test('a replayed confirmation is still answered at and beyond the ceiling',async t=>{
 const f=await fixture(t,{requestLedgerLimit:2}),person=await f.volunteer('Replaying Volunteer');
 const slot=await f.shift({capacity:2}),{token,access}=await f.issue(person.id);
 const signupRequest=uuid(),consentRequest=uuid();
 const created=await f.pub('/reservations',{method:'POST',token,body:{requestId:signupRequest,shiftId:slot.id,join:'Reserved'}});
 assert.equal(created.status,201);
 assert.equal((await f.pub('/consent',{method:'POST',token,body:{requestId:consentRequest,granted:true}})).status,200);
 assert.equal((await f.pub('/consent',{method:'POST',token,body:{requestId:uuid(),granted:false}})).status,409,'the ceiling is reached');
 const replayed=await f.pub('/reservations',{method:'POST',token,body:{requestId:signupRequest,shiftId:slot.id,join:'Reserved'}});
 assert.equal(replayed.status,200);
 assert.equal(replayed.json.replayed,true);
 assert.equal(replayed.json.reservationId,created.json.reservationId);
 const replayedConsent=await f.pub('/consent',{method:'POST',token,body:{requestId:consentRequest,granted:true}});
 assert.equal(replayedConsent.status,200);
 assert.equal(replayedConsent.json.replayed,true);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM volunteer_portal_requests WHERE access_id=?').get(access.id).n,2,'a replay at the ceiling adds no row');
 assert.equal(reservations(f).length,1,'a replay at the ceiling mutates nothing');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM volunteer_consent_changes').get().n,1);
});

test('one exhausted link never affects another volunteer or the staff register',async t=>{
 const f=await fixture(t,{requestLedgerLimit:2});
 const slot=await f.shift({capacity:4});
 const noisy=await f.volunteer('Noisy Volunteer'),quiet=await f.volunteer('Quiet Volunteer');
 const noisyLink=await f.issue(noisy.id),quietLink=await f.issue(quiet.id);
 for(const granted of [true,false])assert.equal((await f.pub('/consent',{method:'POST',token:noisyLink.token,body:{requestId:uuid(),granted}})).status,200);
 assert.equal((await f.pub('/reservations',{method:'POST',token:noisyLink.token,body:{requestId:uuid(),shiftId:slot.id,join:'Reserved'}})).status,409);
 const quietSignup=await f.pub('/reservations',{method:'POST',token:quietLink.token,body:{requestId:uuid(),shiftId:slot.id,join:'Reserved'}});
 assert.equal(quietSignup.status,201,'a separate link keeps its own untouched budget');
 assert.equal((await f.pub('',{token:quietLink.token})).json.link.confirmationsRecorded,1);
 assert.equal((await f.pub('',{token:noisyLink.token})).json.link.confirmationsRecorded,2);
 const register=(await f.request('/volunteer-portal',{session:f.staff})).json;
 assert.equal(register.access.find(a=>a.id===noisyLink.access.id).confirmationsExhausted,true);
 assert.equal(register.access.find(a=>a.id===quietLink.access.id).confirmationsExhausted,false);
 const reissued=await f.request('/volunteer-portal/access/'+noisyLink.access.id+'/revoke',{method:'POST',session:f.staff,body:{version:1,reason:'Link reached its confirmation limit'}});
 assert.equal(reissued.status,200);
 const replacement=await f.issue(noisy.id);
 assert.equal((await f.pub('/reservations',{method:'POST',token:replacement.token,body:{requestId:uuid(),shiftId:slot.id,join:'Reserved'}})).status,201,'a replacement link restores service without deleting retained evidence');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM volunteer_portal_requests').get().n,4);
 assert.throws(()=>f.db.prepare('DELETE FROM volunteer_portal_requests').run(),'retention is unchanged');
});
