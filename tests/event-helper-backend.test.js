import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createApp} from '../server/app.js';

async function fixture(t){
 let tenantActive=true;
 const app=createApp({seed:true,mfaKey:'',isTenantActive:()=>tenantActive}),db=app.locals.db,server=app.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));app.locals.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 async function request(path,{method='GET',body,session,csrf=true}={}){const r=await fetch(base+'/api'+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie}:{}),...(session&&csrf?{'X-CSRF-Token':session.csrfToken}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});return {status:r.status,json:method==='HEAD'?null:await r.json(),headers:r.headers};}
 async function login(email,password='FoundationDemo!2026'){const r=await request('/auth/login',{method:'POST',body:{email,password}});assert.equal(r.status,200,JSON.stringify(r.json));return {...r.json,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const admin=await login('alex@foundation.example'),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 const created=await request('/users',{session:admin,method:'POST',body:{name:'Restricted helper',email:'helper@synthetic.example',password:'SyntheticHelper!2026',role:'event-helper'}});assert.equal(created.status,201,JSON.stringify(created.json));
 let helperUser=created.json.user;
 async function helper(){return login(helperUser.email,'SyntheticHelper!2026');}
 async function create(collection,body){const r=await request('/records/'+collection,{session:admin,method:'POST',body});assert.equal(r.status,201,JSON.stringify(r.json));return r.json.record;}
 const person=await create('constituents',{name:'Attendee display',type:'Individual',email:'PRIVATE_EMAIL@synthetic.example',phone:'PRIVATE_PHONE',notes:'PRIVATE_DONOR_NOTE'});
 const event=await create('events',{name:'Assigned benefit',date:'2026-10-01',location:'Front entrance',capacity:200,ticketPrice:10001,sponsorGoal:50000,notes:'PRIVATE_EVENT_NOTE'});
 const other=await create('events',{name:'UNASSIGNED_EVENT',date:'2026-10-02',capacity:200});
 assert.equal((await request('/events/'+event.id+'/register',{method:'POST',session:staff,body:{constituentId:person.id}})).status,200);
 const currentEvent=()=>JSON.parse(db.prepare("SELECT data FROM records WHERE collection='events' AND id=?").get(event.id).data);
 const issued=await request('/event-operations/events/'+event.id+'/tickets',{method:'POST',session:staff,body:{eventVersion:currentEvent().version,constituentId:person.id}});assert.equal(issued.status,201,JSON.stringify(issued.json));
 async function assign(eventIds=[event.id],extra={}){const r=await request('/users/'+helperUser.id+'/event-access',{method:'PATCH',session:admin,body:{version:helperUser.version,eventIds,reason:'Approved restricted event duty',...extra}});if(r.status===200)helperUser={...helperUser,version:r.json.version};return r;}
 return {app,db,request,admin,staff,viewer,helper,create,event,other,person,ticket:issued.json.ticket,currentEvent,assign,get user(){return helperUser;},suspendTenant:()=>{tenantActive=false;}};
}

test('new helper has zero assignments, self-security access, and default-deny business namespaces',async t=>{
 const f=await fixture(t),session=await f.helper(),events=await f.request('/event-checkin/events',{session});assert.equal(events.status,200);assert.deepEqual(events.json.events,[]);assert.equal(events.headers.get('cache-control'),'no-store');
 assert.equal((await f.request('/auth/me',{session})).json.user.role,'event-helper');assert.equal((await f.request('/auth/mfa/status',{session})).status,200);
 for(const path of ['/workspace','/event-operations','/reporting','/intelligence','/backup','/users','/settings','/documents','/timeline','/migration','/unknown'])assert.equal((await f.request(path,{session})).status,403,path);
 assert.equal((await f.request('/records/communications',{method:'POST',session,body:{}})).status,403);
 assert.equal((await f.request('/event-checkin/events/'+f.event.id,{session})).status,404);
 for(const path of ['/event-checkin/events','/event-checkin/events/'+f.event.id])assert.equal((await f.request(path,{method:'HEAD',session})).status,403);
 assert.equal((await f.request('/event-checkin/events')).status,401);assert.equal((await f.request('/event-checkin/events',{session:f.viewer})).status,403);
 assert.equal((await f.request('/workspace',{session:f.staff})).status,200);assert.equal((await f.request('/workspace',{session:f.viewer})).status,200);
});

test('assignment replacement is strict, versioned, audited and revokes current sessions/challenges',async t=>{
 const f=await fixture(t),session=await f.helper(),path='/users/'+f.user.id+'/event-access';
 f.db.prepare('INSERT INTO mfa_challenges VALUES(?,?,?,?,?)').run('synthetic-pending',f.user.id,Date.now()+300000,0,'synthetic');
 for(const options of [{session:f.staff},{session:f.admin,csrf:false}])assert.equal((await f.request(path,{...options,method:'PATCH',body:{version:1,eventIds:[f.event.id],reason:'Assigned'}})).status,403);
 for(const extra of [{reason:'  '},{eventIds:[f.event.id,f.event.id]},{eventIds:['not-a-uuid']},{eventIds:Array(101).fill(f.event.id)},{unknown:true}])assert.equal((await f.assign([f.event.id],extra)).status,400);
 const result=await f.assign();assert.equal(result.status,200,JSON.stringify(result.json));assert.equal(result.json.version,2);assert.equal(result.json.sessionsRevoked,1);assert.deepEqual(result.json.eventIds,[f.event.id]);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM mfa_challenges WHERE user_id=?').get(f.user.id).n,0);assert.equal((await f.request('/auth/me',{session})).status,401);
 assert.equal((await f.assign([],{version:1})).status,409);assert.deepEqual((await f.request(path,{session:f.admin})).json,{userId:f.user.id,version:2,eventIds:[f.event.id]});
 const history=f.db.prepare('SELECT * FROM event_helper_access_changes WHERE user_id=?').all(f.user.id);assert.equal(history.length,1);assert.deepEqual(JSON.parse(history[0].after_json),[f.event.id]);assert.equal(history[0].reason,'Approved restricted event duty');
 assert.throws(()=>f.db.prepare('UPDATE event_helper_access_changes SET reason=? WHERE id=?').run('tamper',history[0].id));assert.throws(()=>f.db.prepare('DELETE FROM event_helper_access_changes WHERE id=?').run(history[0].id));
});

test('minimal roster and check-in omit financial/contact/history information and retain atomic native attendance',async t=>{
 const f=await fixture(t);assert.equal((await f.assign()).status,200);const session=await f.helper(),path='/event-checkin/events/'+f.event.id;
 const roster=await f.request(path,{session});assert.equal(roster.status,200);assert.deepEqual(Object.keys(roster.json.event).sort(),['date','id','location','name','version']);assert.deepEqual(Object.keys(roster.json.tickets[0]).sort(),['attendeeName','checkedIn','checkedInAt','id','version']);
 for(const marker of ['PRIVATE_EMAIL','PRIVATE_PHONE','PRIVATE_DONOR_NOTE','PRIVATE_EVENT_NOTE',f.person.id,'payments','price','history','balance'])assert.ok(!JSON.stringify(roster.json).includes(marker),marker);
 const snapshot=f.db.prepare('SELECT data FROM records WHERE collection=? ORDER BY id').all('gifts');
 const checked=await f.request(path+'/tickets/'+f.ticket.id+'/checkin',{method:'POST',session,body:{version:1,eventVersion:f.currentEvent().version}});assert.equal(checked.status,200,JSON.stringify(checked.json));assert.equal(checked.json.ticket.version,2);assert.equal(checked.json.ticket.checkedIn,true);assert.deepEqual(Object.keys(checked.json.event).sort(),['id','version']);
 assert.equal(f.currentEvent().registrations[0].checkedIn,true);assert.equal(f.currentEvent().version,checked.json.event.version);assert.equal(f.db.prepare('SELECT checked_in_at FROM event_tickets WHERE id=?').get(f.ticket.id).checked_in_at,checked.json.ticket.checkedInAt);
 const transition=f.db.prepare("SELECT * FROM event_ticket_transitions WHERE ticket_id=? AND action='Checked in'").get(f.ticket.id);assert.equal(JSON.parse(transition.actor_json).role,'event-helper');assert.equal(transition.event_version,checked.json.event.version);
 assert.deepEqual(f.db.prepare('SELECT data FROM records WHERE collection=? ORDER BY id').all('gifts'),snapshot);
 assert.equal((await f.request(path+'/tickets/'+f.ticket.id+'/checkin',{method:'POST',session,body:{version:2,eventVersion:f.currentEvent().version}})).status,409);
 assert.equal((await f.request('/event-operations/tickets/'+f.ticket.id+'/reverse-checkin',{method:'POST',session,body:{version:2,eventVersion:f.currentEvent().version,reason:'Wrong person',confirmed:true}})).status,403);
});

test('stale versions, foreign events, invalid CSRF and audit failures cannot partially check in',async t=>{
 const f=await fixture(t);await f.assign();const session=await f.helper(),path='/event-checkin/events/'+f.event.id+'/tickets/'+f.ticket.id+'/checkin',body={version:1,eventVersion:f.currentEvent().version};
 for(const options of [{body:{...body,version:2}},{body:{...body,eventVersion:1}},{body,csrf:false},{body:{...body,constituentId:f.person.id}}]){const r=await f.request(path,{method:'POST',session,...options});assert.ok([400,403,409].includes(r.status),JSON.stringify(r));}
 assert.equal((await f.request('/event-checkin/events/'+f.other.id+'/tickets/'+f.ticket.id+'/checkin',{method:'POST',session,body})).status,404);
 f.db.exec("CREATE TRIGGER synthetic_checkin_audit_failure BEFORE INSERT ON audit WHEN NEW.action='checkin_event_ticket' BEGIN SELECT RAISE(ABORT,'Synthetic audit unavailable'); END;");
 const failed=await f.request(path,{method:'POST',session,body});assert.equal(failed.status,500);assert.ok(!JSON.stringify(failed.json).includes('Synthetic audit'));
 assert.equal(f.currentEvent().version,body.eventVersion);assert.equal(f.currentEvent().registrations[0].checkedIn,false);assert.equal(f.db.prepare('SELECT version,checked_in_at FROM event_tickets WHERE id=?').get(f.ticket.id).version,1);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM event_ticket_transitions WHERE ticket_id=? AND action='Checked in'").get(f.ticket.id).n,0);
});

test('assignment audit rollback, account-role retirement and tenant suspension remain fail closed',async t=>{
 const f=await fixture(t),session=await f.helper();f.db.exec("CREATE TRIGGER synthetic_assignment_failure BEFORE INSERT ON audit WHEN NEW.action='replace_event_helper_access' BEGIN SELECT RAISE(ABORT,'Synthetic audit unavailable'); END;");
 assert.equal((await f.assign()).status,500);assert.equal(f.db.prepare('SELECT version FROM users WHERE id=?').get(f.user.id).version,1);assert.equal((await f.request('/auth/me',{session})).status,200);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM event_helper_assignments WHERE user_id=?').get(f.user.id).n,0);
 f.db.exec('DROP TRIGGER synthetic_assignment_failure');await f.assign();const fresh=await f.helper();assert.equal((await f.request('/users/'+f.user.id,{session:f.admin,method:'PATCH',body:{version:2,role:'staff',active:true}})).status,200);
 assert.equal((await f.request('/auth/me',{session:fresh})).status,401);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM event_helper_assignments WHERE user_id=? AND active=1').get(f.user.id).n,0);
 assert.equal((await f.request('/users/'+f.user.id,{session:f.admin,method:'PATCH',body:{version:3,role:'event-helper',active:true}})).status,200);const again=await f.helper();assert.deepEqual((await f.request('/event-checkin/events',{session:again})).json.events,[]);
 f.suspendTenant();assert.equal((await f.request('/event-checkin/events',{session:again})).status,403);assert.equal((await f.request('/users/'+f.user.id+'/event-access',{session:f.admin})).status,403);
});

test('roster pagination counts eligible issued records only and retained assignments protect event deletion',async t=>{
 const f=await fixture(t);await f.assign();const extra=await f.create('constituents',{name:'Second attendee',type:'Individual'});await f.request('/events/'+f.event.id+'/register',{method:'POST',session:f.admin,body:{constituentId:extra.id}});
 const second=await f.request('/event-operations/events/'+f.event.id+'/tickets',{method:'POST',session:f.staff,body:{eventVersion:f.currentEvent().version,constituentId:extra.id}});assert.equal(second.status,201);
 const session=await f.helper(),path='/event-checkin/events/'+f.event.id,first=await f.request(path+'?limit=1',{session});assert.equal(first.status,200);assert.equal(first.json.tickets.length,1);assert.equal(first.json.nextCursor,first.json.tickets[0].id);
 const next=await f.request(path+'?limit=1&after='+first.json.nextCursor,{session});assert.equal(next.status,200);assert.equal(next.json.tickets.length,1);assert.notEqual(next.json.tickets[0].id,first.json.tickets[0].id);assert.equal(next.json.nextCursor,null);
 for(const query of ['?limit=101','?after=bad','?search=PRIVATE'])assert.equal((await f.request(path+query,{session})).status,400);
 await f.assign([f.other.id]);await f.assign([]);assert.equal((await f.request('/records/events/'+f.other.id,{session:f.admin,method:'DELETE',body:{version:f.other.version}})).status,409);
});
