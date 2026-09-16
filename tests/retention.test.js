import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/app.js';
import {RETENTION_CLASSES,RETENTION_RESIDENCY} from '../server/observability.js';

const PASSWORD='FoundationDemo!2026';
const YEAR=365.2425*86400000;

async function fixture(t,{tenantId=null}={}){
 const dir=await mkdtemp(join(tmpdir(),'wimblo-retention-'));
 let app,server,base,tenantActive=true,currentTenant=tenantId;
 const time={now:Date.now()};
 async function open(){
  app=createApp({dbPath:join(dir,'workspace.sqlite'),seed:true,mfaKey:'',tenantId:currentTenant,isTenantActive:()=>tenantActive,reminderWorker:false,workflowWorker:false,extensions:{observability:{worker:false,clock:()=>time.now},volunteerPortal:{worker:false},eventPlanning:{worker:false}}});
  server=app.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
 }
 async function close(){if(server)await new Promise(resolve=>server.close(resolve));server=null;app?.locals.close();app=null;}
 await open();
 t.after(async()=>{await close();await rm(dir,{recursive:true,force:true});});
 async function request(path,{method='GET',body,session,csrf=true}={}){
  const r=await fetch(base+'/api'+path,{method,headers:{...(body!==undefined?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie}:{}),...(session&&csrf?{'X-CSRF-Token':session.csrfToken}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const text=await r.text();let json={};try{json=text?JSON.parse(text):{};}catch{}
  return {status:r.status,json};
 }
 async function login(email='alex@foundation.example'){
  const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:PASSWORD})});
  assert.equal(r.status,200);return {...await r.json(),cookie:r.headers.get('set-cookie').split(';')[0]};
 }
 let admin=await login(),staff=await login('staff@foundation.example'),viewer=await login('board@foundation.example');
 async function constituent(name='Retention subject',session=admin){
  const r=await request('/records/constituents',{session,method:'POST',body:{name,email:'',phone:'',type:'Individual',household:'',parentId:null,contacts:[],segments:'',preference:'Email',notes:''}});
  assert.equal(r.status,201,JSON.stringify(r.json));return r.json.record;
 }
 async function designation(name='Retention fund'){
  const r=await request('/records/designations',{session:admin,method:'POST',body:{name,school:'',parentId:null,accountCode:'',description:''}});
  assert.equal(r.status,201,JSON.stringify(r.json));return r.json.record;
 }
 async function gift(donor,fund,amount=2500){
  const r=await request('/records/gifts',{session:admin,method:'POST',body:{constituentId:donor.id,amount,type:'Cash',method:'Check',date:'2026-09-13',campaignId:null,allocations:[{designationId:fund.id,amount}],externalRef:'',notes:'',tribute:'',softCreditId:null,pledge:'',giftKind:'One-time'}});
  assert.equal(r.status,201,JSON.stringify(r.json));return r.json.record;
 }
 return {
  request,constituent,designation,gift,
  get admin(){return admin;},get staff(){return staff;},get viewer(){return viewer;},
  time,
  service:()=>app.locals.extensions.services.observability,
  suspend(){tenantActive=false;},resume(){tenantActive=true;},
  async reopenAs(nextTenant){await close();currentTenant=nextTenant;await open();admin=await login();staff=await login('staff@foundation.example');viewer=await login('board@foundation.example');},
  async restart(){await this.reopenAs(currentTenant);},
  get db(){return app.locals.db;}
 };
}

const hold=(f,body)=>f.request('/retention/holds',{session:f.admin,method:'POST',body});
const deleteRecord=(f,collection,record,session)=>f.request('/records/'+collection+'/'+record.id,{method:'DELETE',session:session||f.admin,body:{version:record.version}});

test('the retention catalogue carries the ten-year minimum, declared residency and honest limits',async t=>{
 const f=await fixture(t);
 const view=await f.request('/retention',{session:f.admin});
 assert.equal(view.status,200);
 assert.equal(view.json.classes.length,RETENTION_CLASSES.length);
 assert.ok(view.json.classes.every(c=>c.minimumYears>=10),'Q&A56 sets a ten-year minimum for every class');
 assert.equal(view.json.classes.find(c=>c.id==='financial-history').destructionPermitted,false);
 assert.equal(view.json.classes.find(c=>c.id==='audit-and-security').destructionPermitted,false);
 assert.equal(view.json.classes.find(c=>c.id==='constituent-record').destructionPermitted,true);
 assert.equal(view.json.residency.declared,'United States or Canada');
 assert.equal(view.json.residency.source,RETENTION_RESIDENCY.source);
 assert.equal(view.json.residency.enforcedInCode,false,'code must not claim verified residency');
 assert.match(view.json.notice,/No operated monitoring service, adopted retention schedule/);
 for(const session of [f.staff,f.viewer])assert.equal((await f.request('/retention',{session})).status,403);
 assert.equal((await f.request('/retention?extra=1',{session:f.admin})).status,400);
});

test('retention class assignment is versioned, validated, audited and retained',async t=>{
 const f=await fixture(t),person=await f.constituent();
 const path='/retention/assignments';
 assert.equal((await f.request(path,{session:f.staff,method:'POST',body:{collection:'constituents',recordId:person.id,classId:'constituent-record'}})).status,403);
 assert.equal((await f.request(path,{session:f.admin,method:'POST',csrf:false,body:{collection:'constituents',recordId:person.id,classId:'constituent-record'}})).status,403);
 assert.equal((await f.request(path,{session:f.admin,method:'POST',body:{collection:'constituents',recordId:person.id,classId:'not-a-class'}})).status,400);
 assert.equal((await f.request(path,{session:f.admin,method:'POST',body:{collection:'nope',recordId:person.id,classId:'constituent-record'}})).status,400);
 assert.equal((await f.request(path,{session:f.admin,method:'POST',body:{collection:'constituents',recordId:person.id,classId:'financial-history'}})).status,400,'a class must cover the collection it is applied to');
 assert.equal((await f.request(path,{session:f.admin,method:'POST',body:{collection:'constituents',recordId:randomUUID(),classId:'constituent-record'}})).status,404);
 assert.equal((await f.request(path,{session:f.admin,method:'POST',body:{collection:'constituents',recordId:person.id,classId:'constituent-record',extra:1}})).status,400);

 const first=await f.request(path,{session:f.admin,method:'POST',body:{collection:'constituents',recordId:person.id,classId:'constituent-record'}});
 assert.equal(first.status,201);
 assert.equal(first.json.assignment.version,1);
 assert.equal(first.json.class.minimumYears,10);
 const second=await f.request(path,{session:f.admin,method:'POST',body:{collection:'constituents',recordId:person.id,classId:'audit-and-security'}});
 assert.equal(second.status,201);
 assert.equal(second.json.assignment.version,2);
 assert.equal(second.json.assignment.id,first.json.assignment.id,'reassignment keeps one assignment and retains its history');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM retention_assignment_events').get().n,2);
 const event=f.db.prepare('SELECT * FROM retention_assignment_events LIMIT 1').get();
 assert.throws(()=>f.db.prepare('UPDATE retention_assignment_events SET class_id=? WHERE id=?').run('x',event.id));
 assert.throws(()=>f.db.prepare('DELETE FROM retention_assignment_events WHERE id=?').run(event.id));
 assert.throws(()=>f.db.prepare('DELETE FROM retention_assignments').run());
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='assign_retention_class'").get().n,2);
 f.suspend();
 assert.equal((await f.request(path,{session:f.admin,method:'POST',body:{collection:'constituents',recordId:person.id,classId:'constituent-record'}})).status,403);
});

test('an active legal hold blocks record deletion and identity consolidation until it is released',async t=>{
 const f=await fixture(t);
 const held=await f.constituent('Held subject'),free=await f.constituent('Unheld subject');
 assert.equal((await hold(f,{collection:'constituents',recordId:held.id,matter:'LEA litigation hold 2026-11',reason:'District counsel instruction'})).status,201);
 const placed=(await f.request('/retention',{session:f.admin})).json.holds[0];
 assert.equal(placed.status,'Active');
 assert.equal(placed.scopeKind,'Record');
 assert.equal((await hold(f,{collection:'constituents',recordId:held.id,matter:'Duplicate',reason:'Duplicate'})).status,409);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM legal_holds').get().n,1,'a refused duplicate writes nothing');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM legal_hold_events').get().n,1);

 const blocked=await deleteRecord(f,'constituents',held);
 assert.equal(blocked.status,409);
 assert.match(blocked.json.error,/active legal hold retains this record/);
 assert.ok(f.db.prepare("SELECT 1 FROM records WHERE collection='constituents' AND id=?").get(held.id),'a held record stays readable');
 assert.equal(f.service().hasConstituentReferences(held.id),true);
 assert.equal(f.service().hasConstituentReferences(free.id),false);
 const merge=await f.request('/identity/merge/preview',{session:f.admin,method:'POST',body:{sourceId:held.id,targetId:free.id,sourceVersion:held.version,targetVersion:free.version,reason:'Consolidate duplicates'}});
 assert.equal(merge.status,409,'a held identity cannot be consolidated away');
 assert.throws(()=>f.service().validateMutation('constituents',held,{...held,mergedInto:free.id}),/active legal hold retains this identity/);
 assert.doesNotThrow(()=>f.service().validateMutation('constituents',held,{...held,name:'Renamed'}),'an ordinary edit is not blocked');

 assert.equal((await f.request('/retention/holds/'+placed.id+'/release',{session:f.staff,method:'POST',body:{version:1,reason:'x'}})).status,403);
 assert.equal((await f.request('/retention/holds/'+placed.id+'/release',{session:f.admin,method:'POST',body:{version:9,reason:'Stale version'}})).status,409);
 assert.equal((await f.request('/retention/holds/'+randomUUID()+'/release',{session:f.admin,method:'POST',body:{version:1,reason:'Missing'}})).status,404);
 assert.equal((await f.request('/retention/holds/'+placed.id+'/release',{session:f.admin,method:'POST',body:{version:1,reason:' '}})).status,400);
 const released=await f.request('/retention/holds/'+placed.id+'/release',{session:f.admin,method:'POST',body:{version:1,reason:'Counsel released the matter'}});
 assert.equal(released.status,200);
 assert.equal(released.json.hold.status,'Released');
 assert.equal((await f.request('/retention/holds/'+placed.id+'/release',{session:f.admin,method:'POST',body:{version:2,reason:'Again'}})).status,409);
 assert.equal(f.service().hasConstituentReferences(held.id),false);
 const current=JSON.parse(f.db.prepare("SELECT data FROM records WHERE collection='constituents' AND id=?").get(held.id).data);
 assert.equal((await deleteRecord(f,'constituents',current)).status,200,'deletion is permitted once the hold is released');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM legal_hold_events').get().n,2,'placement and release are both retained');
 assert.throws(()=>f.db.prepare('DELETE FROM legal_holds').run());
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit WHERE action IN ('place_legal_hold','release_legal_hold')").get().n,2);
 assert.ok(f.service().counters().legal_hold_blocked_deletion_total>=1);
});

test('a collection-wide legal hold covers every record in that collection',async t=>{
 const f=await fixture(t),person=await f.constituent('Collection scope subject');
 assert.equal((await hold(f,{collection:'constituents',recordId:null,matter:'Whole-collection preservation',reason:'Regulatory inquiry'})).status,201);
 const blocked=await deleteRecord(f,'constituents',person);
 assert.equal(blocked.status,409);
 const later=await f.constituent('Created after the hold');
 assert.equal((await deleteRecord(f,'constituents',later)).status,409,'a collection hold covers records created after it');
 const holds=(await f.request('/retention',{session:f.admin})).json.holds;
 assert.equal(holds[0].scopeKind,'Collection');
 assert.equal(holds[0].recordId,null);
});

test('deletion requests move through blocked, refused, approved and recorded states without destroying history',async t=>{
 const f=await fixture(t);
 const fund=await f.designation(),donor=await f.constituent('Disposition donor'),posted=await f.gift(donor,fund);
 const path='/retention/deletion-requests';

 // Financial history can never be approved for destruction.
 const financial=await f.request(path,{session:f.admin,method:'POST',body:{collection:'gifts',recordId:posted.id,reason:'District disposition instruction'}});
 assert.equal(financial.status,201);
 assert.equal(financial.json.request.state,'Requested');
 assert.equal(financial.json.class.id,'financial-history');
 const refusedFinancial=await f.request(path+'/'+financial.json.request.id+'/decide',{session:f.admin,method:'POST',body:{version:1,decision:'Approve',reason:'Attempt approval'}});
 assert.equal(refusedFinancial.status,409);
 assert.match(refusedFinancial.json.error,/never permits destruction/);
 assert.equal(f.db.prepare('SELECT state,version FROM deletion_requests WHERE id=?').get(financial.json.request.id).state,'Requested','a refused approval leaves no partial decision');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM deletion_request_events WHERE request_id=?').get(financial.json.request.id).n,1);

 // A subject record inside its ten-year minimum cannot be approved either.
 const subject=await f.constituent('Disposition subject');
 const request=await f.request(path,{session:f.admin,method:'POST',body:{collection:'constituents',recordId:subject.id,reason:'Parent request routed through the district'}});
 assert.equal(request.status,201);
 assert.equal(request.json.request.state,'Requested');
 assert.equal((await f.request(path,{session:f.admin,method:'POST',body:{collection:'constituents',recordId:subject.id,reason:'Duplicate'}})).status,409);
 assert.equal((await f.request(path,{session:f.admin,method:'POST',body:{collection:'constituents',recordId:randomUUID(),reason:'Missing record'}})).status,404);
 const tooEarly=await f.request(path+'/'+request.json.request.id+'/decide',{session:f.admin,method:'POST',body:{version:1,decision:'Approve',reason:'Approve early'}});
 assert.equal(tooEarly.status,409);
 assert.match(tooEarly.json.error,/10-year minimum retention/);

 // Past the minimum, approval and a recorded disposition become possible.
 const created=Date.parse(f.db.prepare("SELECT data FROM records WHERE collection='constituents' AND id=?").get(subject.id)?JSON.parse(f.db.prepare("SELECT data FROM records WHERE collection='constituents' AND id=?").get(subject.id).data).createdAt:new Date().toISOString());
 f.time.now=created+11*YEAR;
 assert.equal((await f.request(path+'/'+request.json.request.id+'/decide',{session:f.admin,method:'POST',body:{version:9,decision:'Approve',reason:'Stale version'}})).status,409);
 assert.equal((await f.request(path+'/'+request.json.request.id+'/decide',{session:f.staff,method:'POST',body:{version:1,decision:'Approve',reason:'Wrong role'}})).status,403);
 const approved=await f.request(path+'/'+request.json.request.id+'/decide',{session:f.admin,method:'POST',body:{version:1,decision:'Approve',reason:'District instruction verified'}});
 assert.equal(approved.status,200,JSON.stringify(approved.json));
 assert.equal(approved.json.request.state,'Approved');
 assert.match(approved.json.notice,/does not destroy retained financial or audit history/);

 assert.equal((await f.request(path+'/'+request.json.request.id+'/record-disposition',{session:f.admin,method:'POST',body:{version:1,reason:'Stale'}})).status,409);
 const recorded=await f.request(path+'/'+request.json.request.id+'/record-disposition',{session:f.admin,method:'POST',body:{version:2,reason:'Disposition performed under district instruction',disposition:'Disposed under district instruction'}});
 assert.equal(recorded.status,200,JSON.stringify(recorded.json));
 assert.equal(recorded.json.request.state,'Recorded');
 assert.equal(recorded.json.historyDestroyed,false);
 assert.equal(recorded.json.evidenceRetained,true);
 assert.equal(recorded.json.tombstone.historyDestroyed,false);
 assert.match(recorded.json.tombstone.recordDigest,/^[a-f0-9]{64}$/);
 assert.match(recorded.json.notice,/does not erase retained financial history, audit rows, receipts or recovery archives/);
 assert.ok(f.db.prepare("SELECT 1 FROM records WHERE collection='constituents' AND id=?").get(subject.id),'a recorded disposition never erases the retained record');
 assert.equal((await f.request(path+'/'+request.json.request.id+'/record-disposition',{session:f.admin,method:'POST',body:{version:3,reason:'Again'}})).status,409);

 const tombstone=f.db.prepare('SELECT * FROM deletion_tombstones').get();
 assert.throws(()=>f.db.prepare('UPDATE deletion_tombstones SET disposition=? WHERE id=?').run('x',tombstone.id));
 assert.throws(()=>f.db.prepare('DELETE FROM deletion_tombstones WHERE id=?').run(tombstone.id));
 assert.throws(()=>f.db.prepare('DELETE FROM deletion_requests').run());
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM audit WHERE action IN ('request_record_disposition','decide_record_disposition','record_record_disposition')").get().n,4);

 // An explicit refusal is a retained terminal state.
 const other=await f.constituent('Refused subject');
 const refusable=await f.request(path,{session:f.admin,method:'POST',body:{collection:'constituents',recordId:other.id,reason:'Second request'}});
 const refusal=await f.request(path+'/'+refusable.json.request.id+'/decide',{session:f.admin,method:'POST',body:{version:1,decision:'Refuse',reason:'No lawful district instruction supplied'}});
 assert.equal(refusal.status,200);
 assert.equal(refusal.json.request.state,'Refused');
 assert.equal((await f.request(path+'/'+refusable.json.request.id+'/decide',{session:f.admin,method:'POST',body:{version:2,decision:'Approve',reason:'Reverse'}})).status,409);
 const counters=f.service().counters();
 assert.ok(counters.deletion_requested_total>=3&&counters.deletion_recorded_total===1&&counters.deletion_refused_total>=1&&counters.deletion_approved_total>=1,JSON.stringify(counters));
});

test('a legal hold placed after approval still blocks the recorded disposition',async t=>{
 const f=await fixture(t),subject=await f.constituent('Late hold subject');
 const path='/retention/deletion-requests';
 const request=await f.request(path,{session:f.admin,method:'POST',body:{collection:'constituents',recordId:subject.id,reason:'Routine disposition'}});
 const stored=JSON.parse(f.db.prepare("SELECT data FROM records WHERE collection='constituents' AND id=?").get(subject.id).data);
 f.time.now=Date.parse(stored.createdAt)+11*YEAR;
 const approved=await f.request(path+'/'+request.json.request.id+'/decide',{session:f.admin,method:'POST',body:{version:1,decision:'Approve',reason:'Approved'}});
 assert.equal(approved.status,200);
 assert.equal((await hold(f,{collection:'constituents',recordId:subject.id,matter:'Hold arrived after approval',reason:'New litigation'})).status,201);
 const blocked=await f.request(path+'/'+request.json.request.id+'/record-disposition',{session:f.admin,method:'POST',body:{version:2,reason:'Proceed anyway'}});
 assert.equal(blocked.status,409,'authority is rechecked at execution time, not only at approval');
 assert.match(blocked.json.error,/active legal hold blocks this disposition/);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM deletion_tombstones').get().n,0);
 assert.equal(f.db.prepare('SELECT state FROM deletion_requests WHERE id=?').get(request.json.request.id).state,'Approved');
 const held=await f.request(path,{session:f.admin,method:'POST',body:{collection:'constituents',recordId:subject.id,reason:'Second'}});
 assert.equal(held.status,409,'the first request is still open');
});

test('a disposition that cannot write its retained evidence rolls back completely',async t=>{
 const f=await fixture(t),subject=await f.constituent('Atomic subject');
 const path='/retention/deletion-requests';
 const request=await f.request(path,{session:f.admin,method:'POST',body:{collection:'constituents',recordId:subject.id,reason:'Routine disposition'}});
 const id=request.json.request.id;
 const stored=JSON.parse(f.db.prepare("SELECT data FROM records WHERE collection='constituents' AND id=?").get(subject.id).data);
 f.time.now=Date.parse(stored.createdAt)+11*YEAR;
 assert.equal((await f.request(path+'/'+id+'/decide',{session:f.admin,method:'POST',body:{version:1,decision:'Approve',reason:'Approved'}})).status,200);
 // Occupy the one-tombstone-per-request slot so the final retained write fails.
 f.db.prepare('INSERT INTO deletion_tombstones VALUES(?,?,?,?,?,?,?,?,?,1,0,?,?)').run(randomUUID(),'workspace',id,'constituents',subject.id,'constituent-record','0'.repeat(64),1,'Conflicting evidence row','seed',new Date().toISOString());
 const events=f.db.prepare('SELECT COUNT(*) n FROM deletion_request_events WHERE request_id=?').get(id).n;
 const attempt=await f.request(path+'/'+id+'/record-disposition',{session:f.admin,method:'POST',body:{version:2,reason:'Record it'}});
 assert.equal(attempt.status,500,'the failure surfaces rather than silently recording a disposition with no evidence');
 const after=f.db.prepare('SELECT * FROM deletion_requests WHERE id=?').get(id);
 assert.equal(after.state,'Approved','the state change rolled back with the failed evidence write');
 assert.equal(after.version,2);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM deletion_request_events WHERE request_id=?').get(id).n,events,'no partial event row survives');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM deletion_tombstones WHERE request_id=?').get(id).n,1,'only the pre-seeded row remains');
});

test('retention state survives a restart and stays inside its own tenant scope',async t=>{
 const tenantA='1f9e0c7a-3d2b-4c55-8a41-9b0c2d6e7f10',tenantB='2a8d1b6c-4e3f-4d66-9b52-0c1d3e7f8a21';
 const f=await fixture(t,{tenantId:tenantA});
 const subject=await f.constituent('Tenant scoped subject');
 assert.equal((await hold(f,{collection:'constituents',recordId:subject.id,matter:'Tenant A matter',reason:'Tenant A instruction'})).status,201);
 assert.equal((await f.request('/retention/deletion-requests',{session:f.admin,method:'POST',body:{collection:'constituents',recordId:subject.id,reason:'Tenant A request'}})).json.request.state,'Blocked','a covered record is recorded as blocked, not silently deletable');
 assert.equal((await deleteRecord(f,'constituents',subject)).status,409);

 await f.restart();
 const persisted=(await f.request('/retention',{session:f.admin})).json;
 assert.equal(persisted.holds.length,1);
 assert.equal(persisted.holds[0].status,'Active');
 assert.equal(persisted.deletionRequests[0].state,'Blocked');
 assert.equal(f.service().activeHolds(),1,'the in-memory hold cache is rebuilt from the database on restart');
 assert.equal((await deleteRecord(f,'constituents',subject)).status,409,'the hold still blocks deletion after a restart');

 await f.reopenAs(tenantB);
 const other=(await f.request('/retention',{session:f.admin})).json;
 assert.deepEqual(other.holds,[],'another tenant never sees or inherits a hold');
 assert.deepEqual(other.deletionRequests,[]);
 assert.equal(f.service().activeHolds(),0);
 assert.equal(f.service().hasConstituentReferences(subject.id),false);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM legal_holds WHERE status='Active'").get().n,1,'the other tenant rows are retained, just out of scope');
 const deleted=await deleteRecord(f,'constituents',subject);
 assert.equal(deleted.status,200,'a hold belonging to another tenant does not govern this tenant');
});
